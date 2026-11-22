import { AsyncLocalStorage } from 'node:async_hooks';

/*
 * A "sample run" (scripted demo scenarios, src/scenarios.js): while code runs inside sampleRun.run(...), nothing
 * leaves the server – emails are skipped (not even logged) and optional AI extras (the chat summary) are not called.
 * WhatsApp is already impossible there: the sample business has no WhatsApp number and every reply is captured.
 */
export const sampleRun = new AsyncLocalStorage();
export const inSampleRun = () => !!sampleRun.getStore();
