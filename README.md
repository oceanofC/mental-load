# Mental Load

See the work. Share the work.

A small installable web app for a household's chores and routines: who owns each one, who did it, what's due, and a light points-and-badges layer. Built for two Android phones.

- `index.html` is the whole app (vanilla JS, no build step).
- `sw.js` caches the app for offline use and shows reminder notifications.
- Data lives in a Supabase project. The app only talks to it through key-checked database functions, and each household is reached with its own private link.
- `supabase/functions/ml-push` is the reminder sender, run every minute by a scheduled job.
