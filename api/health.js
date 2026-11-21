// GET /api/health → {"ok":true}
import { json } from '../lib/http.js';

export function GET() {
  return json(200, { ok: true });
}
