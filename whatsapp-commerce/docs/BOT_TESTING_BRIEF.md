# Brief: test the chat assistant on thousands of real websites

This is for an AI agent (or a person) who will test the assistant at scale and report what to improve.

**Product:** a UK chat assistant for small businesses, on website chat and WhatsApp. It reads a business's own website and then answers its customers.

**The job:**
1. Run the assistant against many real business websites.
2. Judge every answer.
3. Group the failures by cause.
4. Report what to fix, with evidence.
5. Optionally, propose code fixes with tests.

## 1. Access: what you get, and what you don't

| You need | Where it comes from |
|---|---|
| The code | Public repo `https://github.com/ksushils/Automations`, folder `whatsapp-commerce/` (branch `main`). |
| An AI key | **Your own OpenRouter key** (openrouter.ai), with a spending limit set on it, for example $80. Never use the production key. |
| A computer | Any machine with Node.js 22 or newer and internet access. No server, no database and no Docker are needed. |

**You do NOT get, and must not ask for:**
- access to the production server;
- its database, `.env` file or logs;
- any business's real chats, customers or orders;
- the owner's accounts (Meta, Stripe, email, GitHub write access).

The test tool needs none of these. Every run uses a throwaway in-memory database that disappears when it ends, and it sends no emails or WhatsApp messages.

## 2. Setup (5 minutes)

```sh
git clone https://github.com/ksushils/Automations.git
cd Automations/whatsapp-commerce
npm ci
export AI_API_KEY=sk-or-...            # your OpenRouter key (PowerShell: $env:AI_API_KEY="sk-or-...")
export AI_MODEL=openai/gpt-4o-mini     # the production model – keep this so results match what customers get
export ENCRYPTION_KEY=$(openssl rand -hex 32)   # any random value; only used inside the throwaway database
```

**Check that it works:**
```sh
node --disable-warning=ExperimentalWarning src/cli/trySite.js https://travelrise.in
```

You should see a conversation, with `ai` next to most answers. If it prints "The AI key does not work", fix the key first. Without a working key the bot falls back to pasting raw page text, and every result would be meaningless.

## 3. Running

**One site, with your own questions:**
```sh
node --disable-warning=ExperimentalWarning src/cli/trySite.js https://example.co.uk "Do you deliver to Leeds?" "How much is a haircut?"
```

**Many sites** (one address per line in `sites.txt`; `#` comments are allowed):
```sh
node --disable-warning=ExperimentalWarning src/cli/trySites.js sites.txt results.jsonl --parallel 3
```

**How the batch runner behaves:**
- It writes one JSON line per site to `results.jsonl`.
- It is safe to stop and restart: sites already in the file are skipped.
- It stops at once if the AI key fails.
- Each site takes about 30–60 seconds.
- 5,000 sites at `--parallel 3` take roughly 1–2 days of running.
- Cost is about 1p per site in OpenRouter usage, so roughly $50–70 for 5,000. This is billed to your own OpenRouter key; Grok's free usage doesn't cover it.

**What each run does:**
- **Reads the site** the way the product's instant demo does: home page, menu links, sitemap and common pages, at most 14 pages, 4 at a time.
- **Sets the assistant up**: business name, trade, welcome menu.
- **Asks questions:** 4 suggested for that business, plus a standard set covering greeting, opening hours, price, location and contact, how to book or order, a made-up discount (a trap: the right answer is "I can't see that"), a follow-up that depends on the previous answer, and a typo-filled question.

**Fields in each result line:**
- `ok`, `error`: whether the site could be read.
- `name`, `trade`, `pages`, `menu`: what the setup produced.
- `chat[]`: one entry per question:
  - `q` and `a`: the question, and the reply with its buttons in `[a | b]`;
  - `by`: `ai` (the AI wrote it) or `bot` (fixed flows such as greeting, booking or handover);
  - `flags`: for example `unsupported_figures` (a number not found in the sources), `no_source` or `price_blocked`;
  - `sources`: the pages the answer was based on.

## 4. Choosing the sites

- **Target:** UK small and medium businesses, matching the product's customers.
  - **Trades:** takeaways and restaurants, cafés and bakeries, salons and barbers, dentists and clinics, plumbers, electricians and other trades, garages, gyms, driving schools, travel agents, experience and activity businesses, independent shops (Shopify and WooCommerce), PC and electronics sellers, florists, vets, cleaners, letting agents.
  - Mix the trades. Prefer real independent businesses over national chains.
  - Include some non-UK English-language sites and a few non-English ones.
- **Sources:** build the list from public business directories or search results. Don't buy lists, and don't collect personal data: you need only the website address.
- **Avoid:** government sites, health-record portals, adult, gambling or weapons sites, anything behind a login, and the same chain twice.

## 5. Rules you must follow

1. **Be polite to websites.**
   - Keep `--parallel` at 3 (maximum 6).
   - Don't change the reader's identity (user-agent) or delays.
   - Never try to get past a site that blocks automated visits: no browser user-agent, no proxies, no CAPTCHA solving. A blocked site is a valid result ("could not read"), so record it and move on.
2. **Never send anything to anyone:**
   - no contact forms, no sign-ups, no orders;
   - no messages to the businesses you test;
   - no posting results anywhere public.
3. **Keep results private.** Transcripts contain other businesses' website text.
   - Do not commit `results.jsonl` or transcripts to the repository: **it is public**.
   - Share them with the owner privately.
   - In reports, quote short excerpts only.
4. **No access beyond this brief.** Don't try to reach the production server, admin endpoints or real businesses' chats.
5. **Code changes:**
   - Make them on your own branch or fork, and propose them as a pull request or a patch file.
   - Never push to `main`, and never deploy. The owner reviews and deploys.
   - Every fix needs a test in `test/`, and the whole suite must pass: `node --disable-warning=ExperimentalWarning --test test/*.test.js`.
   - Tests must never call a real AI or website. Mock `fetch`; see `test/answer-quality.test.js`.
6. **Never put a key or password** in a file, a commit, a pull request or a report.

## 6. How to judge an answer

Give each AI answer one verdict. Check it against the site's real page, because the `sources` field tells you where to look.

| Verdict | Meaning |
|---|---|
| ✅ good | Correct, specific, taken from the site, and helpful. |
| 🟡 vague | Correct but unhelpful when the site had the answer. Example: "check our website" when the price is on the page. |
| 🔴 wrong | States something false, including a wrong price, wrong hours, or the wrong department or email. |
| 🔴 invented | States something the site doesn't say (a service, a policy, a discount or a time). |
| 🔴 denied | Says "we don't offer X" when the site simply doesn't mention it. The right answer is "I can't see that – shall I check with the team?" |
| 🟠 missed | Says it doesn't know, but the information is on a page it read (a search problem) or on a page it didn't read (a page-choice problem: say which page). |
| 🟠 flow | Problems with the conversation: hands over without asking, asks two questions at once, gives silly or invented buttons, or loops. |
| 🟠 format | Labels cut mid-word, raw page text pasted, broken links, or the wrong currency. |

**Also check the setup itself:**
- the business name detected;
- the trade;
- whether the welcome menu suits the business;
- whether the 14 pages read were the useful ones (prices, contact, services, FAQ) or junk (legal, careers, investors, acquisitions).

## 7. What to deliver

1. **`summary.md`**: what you tested (counts by trade, how many sites could be read) and the overall verdict breakdown. Then the top 10 problems, ranked by how many conversations they affect. For each problem give:
   - what goes wrong, with 2–3 short examples (site, question, answer, and what it should have said, with the source page address);
   - the likely cause in the code (file and function, where you can tell);
   - a suggested fix and how to test it.
2. **`findings.csv`**: one row per judged answer, with columns `url, trade, question, verdict, short_reason, source_url`.
3. **Optionally, pull requests** for clear-cut fixes, each with tests. Keep it to one problem per pull request.

**Every few hundred sites, send an interim summary** so fixes can start early. Re-run the same sites after a fix to show it worked.

## 8. Where things live in the code

| Area | File |
|---|---|
| Reading a site (which pages, how many) | `src/instantDemo.js` (`buildDemo`), `src/knowledge.js` (`safeFetch`, `sitemapPages`, `rankPaths`, `htmlToText`) |
| Setting up the business (name, trade, menu) | `src/knowledge.js` (`detectWebsite`), `src/autoSetup.js`, `src/trades.js` |
| Finding the right passages | `src/ai/rag.js` (`retrieve`, `queryTerms`, `priceRows`; keyword plus meaning-based search) |
| The AI reply and its rules | `src/ai/direct.js` (`directTurn`), `src/dify/provision.js` (`buildPrompt`) |
| Price and figure checks | `src/verified.js` (`guardPrices`, `checkAnswer`) |
| Buttons, handover and fallbacks | `src/bot/engine.js` (`askDirect`, `extractChoices`, `handover`, `shortLabel`) |
| The test tools | `src/cli/trySite.js`, `src/cli/trySites.js` |

## 9. Already known (26 Nov 2026), so no need to report again

- **Blocked sites:** some sites block automated visits (Audley Travel, Bupa, Kwik Fit, Trailfinders, Honest Burgers). That's expected.
- **Slow sites:** Evans Cycles timed out after 2 minutes.
- **Chains:** for a chain, contact details can come from a corporate page. For example, mydentist read its "acquisitions" pages and gave the acquisitions email. The page choice should skip corporate, investor, legal and careers pages.
- **Business name:** sometimes taken from the page title ("PCs & Components" for Overclockers).
- **Demo bookings:** for clinics, salons and experiences, the demo switches on sample booking times, so the bot says "type *book* to pick a time". That's demo behaviour, but its wording for things like emergency appointments is worth a look.
- **Different prices for one item:** when the same item has different prices on different pages (Dishoom's delivery menu £10.50 vs restaurant £11.50), the bot gives one without saying which.
- **Fixed in batch 17, re-check it stays fixed:**
  - "puddings" vs desserts search;
  - prices without a £ sign;
  - handover without asking;
  - "we don't offer" denials;
  - double team offers;
  - labels cut mid-word.
