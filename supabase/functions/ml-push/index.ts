// Mental Load reminder sender.
// - action "tick": called every minute by pg_cron with the job secret. Pushes a reminder to each owner's
//   phone when a routine comes due (or comes back from snooze), and an 08:00 nudge for anything waiting.
// - action "test": a phone asks for a test notification for its own subscription (household key required).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import webpush from "npm:web-push@3.6.7";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-ml-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

let vapidReady = false;
async function ensureVapid() {
  if (vapidReady) return;
  const [row] = await sql`select ml_private.push_config() as c`;
  const c = row.c as Record<string, string>;
  webpush.setVapidDetails(c.vapid_subject, c.vapid_public, c.vapid_private);
  vapidReady = true;
}

type Sub = { endpoint: string; member: string; p256dh: string; auth: string };
type Payload = { title: string; body: string; tag: string; url: string };

async function send(s: { endpoint: string; p256dh: string; auth: string }, p: Payload): Promise<"ok" | "gone" | "err"> {
  try {
    await webpush.sendNotification(
      { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
      JSON.stringify(p),
      { TTL: 4 * 3600, urgency: "high" },
    );
    return "ok";
  } catch (e) {
    const code = (e as { statusCode?: number })?.statusCode;
    if (code === 404 || code === 410) return "gone";
    console.error("push failed", code, (e as { body?: string })?.body ?? String(e));
    return "err";
  }
}

function localStr(d: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const p: Record<string, string> = {};
  for (const x of parts) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const plural = (title: string) => {
  const w = String(title).trim().split(/\s+/)[0].toLowerCase();
  return /[^s]s$/.test(w) && !/(ss|us|is)$/.test(w);
};
const partOfDay = (local: string) => {
  const h = Number(local.slice(11, 13));
  return h < 12 ? "this morning" : h < 17 ? "this afternoon" : "this evening";
};
const listNames = (n: string[]) => (n.length <= 1 ? n[0] ?? "" : n.slice(0, -1).join(", ") + " and " + n[n.length - 1]);

// deno-lint-ignore no-explicit-any
type Task = any;

async function tick(secret: string) {
  const [row] = await sql`select ml_private.push_work(${secret}) as w`;
  // deno-lint-ignore no-explicit-any
  const work = row.w as any[];
  const ok: string[] = [];
  const gone: string[] = [];
  let sent = 0;
  for (const h of work) {
    const fromL = localStr(new Date(h.from), h.tz);
    const toL = localStr(new Date(h.to), h.tz);
    const members: Record<string, { name: string }> = {};
    const areas: Record<string, unknown> = {};
    const tasks: Task[] = [];
    for (const d of h.docs) {
      if (d.coll === "members") members[d.id] = d.data;
      else if (d.coll === "areas") areas[d.id] = d.data;
      else if (d.coll === "tasks") tasks.push({ ...d.data, id: d.id });
    }
    const active = tasks.filter((t) => !t.archived && areas[t.areaId] && t.nextDue);
    const effOf = (t: Task) => (t.snoozedUntil && t.snoozedUntil > t.nextDue ? t.snoozedUntil : t.nextDue);
    const owner = (t: Task) => {
      const names = (t.assigneeIds || []).filter((id: string) => members[id]).map((id: string) => members[id].name);
      return names.length === 1 ? `Assigned to ${names[0]}.` : names.length ? `Shared by ${listNames(names)}.` : "";
    };
    const out: { member: string; p: Payload }[] = [];

    for (const t of active) {
      const eff = effOf(t);
      if (eff > fromL && eff <= toL) {
        const snoozed = eff !== t.nextDue;
        const body = snoozed
          ? `${t.title} ${plural(t.title) ? "are" : "is"} back from snooze. ${owner(t)}`
          : `${t.title} ${plural(t.title) ? "are" : "is"} due ${partOfDay(eff)}. ${owner(t)}`;
        for (const m of t.assigneeIds || []) {
          out.push({ member: m, p: { title: `${t.title} · ${eff.slice(11)}`, body, tag: "ml-" + t.id, url: "./#task-" + t.id } });
        }
      }
    }

    const today = toL.slice(0, 10);
    const nudge = today + "T08:00";
    if (fromL < nudge && nudge <= toL) {
      for (const mid of Object.keys(members)) {
        const waiting = active.filter((t) => (t.assigneeIds || []).includes(mid) && effOf(t) < today + "T00:00");
        if (waiting.length) {
          out.push({
            member: mid,
            p: {
              title: waiting.length === 1 ? "1 thing is waiting" : `${waiting.length} things are waiting`,
              body: "From earlier: " + listNames(waiting.map((t) => t.title)) + ".",
              tag: "ml-morning",
              url: "./#prompts",
            },
          });
        }
      }
    }

    for (const o of out) {
      for (const s of (h.subs as Sub[]).filter((s) => s.member === o.member)) {
        const r = await send(s, o.p);
        sent++;
        if (r === "ok") ok.push(s.endpoint);
        else if (r === "gone") gone.push(s.endpoint);
      }
    }
  }
  if (ok.length || gone.length) await sql`select ml_private.push_result(${ok}::text[], ${gone}::text[])`;
  return { households: work.length, sent, gone: gone.length };
}

async function sendTest(key: string, endpoint: string) {
  const [row] = await sql`select ml_private.push_test_sub(${key}, ${endpoint}) as s`;
  const s = row.s;
  const r = await send(s, {
    title: "Reminders are on",
    body: `This phone will get ${s.name}'s reminders from Mental Load.`,
    tag: "ml-test",
    url: "./",
  });
  if (r === "gone") await sql`select ml_private.push_result(${[]}::text[], ${[endpoint]}::text[])`;
  return { result: r };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body */ }
  try {
    await ensureVapid();
    if (body.action === "tick") return json(await tick(req.headers.get("x-ml-cron") ?? ""));
    if (body.action === "test") {
      if (typeof body.key !== "string" || typeof body.endpoint !== "string") return json({ error: "key and endpoint required" }, 400);
      return json(await sendTest(body.key, body.endpoint));
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const m = (e as Error)?.message ?? String(e);
    const denied = /not allowed|unknown household|not subscribed/.test(m);
    if (!denied) console.error(m);
    return json({ error: denied ? m : "server error" }, denied ? 403 : 500);
  }
});
