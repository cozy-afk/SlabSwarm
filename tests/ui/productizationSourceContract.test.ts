import { registerProductizationSourceContractTests } from './productizationSourceContract.ts';

// The repository's `npm test` glob covers tests/*.test.ts and
// tests/benchmarks/*.test.ts, but not tests/ui/*.test.ts. Registering here
// keeps the UI source contract in the CI path while the sibling .test.ts file
// documents its canonical location under tests/ui/.
registerProductizationSourceContractTests();
