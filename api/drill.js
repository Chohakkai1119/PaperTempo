// POST /api/drill → { targetBar, drill, source: "cortex" | "fallback" }
// See lib/drill.js. The rate limiter lives at module level, so it is per function instance.
import { createDrillHandler } from '../lib/drill.js';
import { json } from '../lib/http.js';

export const POST = createDrillHandler();

export function GET() {
  return json(405, { error: 'Use POST with a JSON body.' }, { allow: 'POST' });
}
