// Server-side recording only. The pure view modules (taxonomy, filter, group)
// are imported by path so client bundles never pull in the database client.
export { recordActivity } from "./record";
