import { Database } from "bun:sqlite"
import { EventData } from "../src/event/data"

const [filename, id] = process.argv.slice(2)
if (!filename || !id) throw new Error("Usage: bun script/event-inspect.ts <database> <event-id>")
// Deliberately bypass the application database layer: no migrations, WAL setup, or checkpoints.
using db = new Database(filename, { readonly: true })
const row = db.query("SELECT id, aggregate_id, seq, type, data FROM event WHERE id = ?").get(id) as {
  id: string
  aggregate_id: string
  seq: number
  type: string
  data: string | Uint8Array
} | null
if (!row) throw new Error(`Event not found: ${id}`)
console.log(JSON.stringify({ ...row, data: EventData.decode(row.data) }, null, 2))
