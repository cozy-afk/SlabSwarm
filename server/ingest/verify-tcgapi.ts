// Live TCGAPIs key verification. Prints ONLY a status token; never the key,
// never the response body. Run with:
//   TCGAPI_ENABLED=true TCGAPI_KEY=... npx tsx server/ingest/verify-tcgapi.ts
// Exit codes: 0 = OK, 2 = DISABLED/NO_KEY, 3 = UNAUTHORIZED/ERROR (status only).

import { verifyTcgapiStatus } from './adapters/tcgapis.ts';

const status = await verifyTcgapiStatus();
console.log(`TCGAPI_STATUS=${status}`);
process.exitCode = status === 'OK' ? 0 : status === 'DISABLED' || status === 'NO_KEY' ? 2 : 3;
