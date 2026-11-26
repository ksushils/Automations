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
  - `flags`: for example `unsupported_figures` (a number not found in the sources), `no_source`, `price_blocked` (an amount was removed) or `time_blocked` (a time or duration was removed);
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

The point is to judge every answer against **the business's own website**, not against your general knowledge. A customer is asking *this* business, and the bot may only say what *this* business says.

### 6.1 The procedure, for every answer

Do these steps in order and stop at the first failure. That failure is the verdict.

1. **Read the question as the customer meant it.** What did they actually want to know or do? Use the previous turn for follow-ups ("and how long does that take?").
2. **List every claim in the answer.** A claim is any fact: a price, time, day, place, phone number, email, link, service, product, policy (returns, delivery, cancellation), a promise ("we'll call you today"), or a yes or no.
3. **Check each claim against the site.**
   - Open the pages in `sources` first, then the other pages in `pages`.
   - If it isn't there, search the live site: use its own search, or `site:` in a search engine.
   - Mark each claim:
     - *supported*: it says this;
     - *contradicted*: it says something different;
     - *not found*: it doesn't say this anywhere.
4. **Check that the answer answers the question.** Does it give what was asked, as specifically as the site allows? A correct answer to a different question is not good.
5. **Check what the bot should have known.** If the answer is "I'm not sure" or "check the website", look for the answer on the site.
   - Found it on a page in `pages`: **missed (search)**.
   - Found it on a page the bot didn't read: **missed (page choice)**. Note the page address.
6. **Check the conversation.**
   - At most one question back to the customer.
   - Buttons that make sense for this business.
   - No handover to a person unless the customer asked, complained or agreed.
   - It never claims to have booked, reserved, ordered or confirmed anything.
7. **Check the form.**
   - Under about 70 words, unless listing items.
   - WhatsApp formatting only (`*bold*`, `_italic_`): no tables, headings or raw HTML.
   - No pasted menu or navigation junk ("Open search Open cart Menu").
   - Links point to the business's own site and work.
   - Prices are in the site's currency.
   - Button labels are complete words.
   - The reply is in the language the customer wrote in.

### 6.2 Verdicts

Give each answer **exactly one** verdict, the worst that applies.

| Verdict | Severity | When |
|---|---|---|
| 🔴 **wrong** | critical | Any claim *contradicted* by the site: a wrong price, wrong hours, wrong phone, email or address, the wrong department (for example an investors email given as customer contact), wrong yes/no. |
| 🔴 **invented** | critical | Any claim *not found* on the site that a customer might act on: a price, discount, service, delivery time, policy, opening time, or a promise of action. |
| 🔴 **denied** | major | "We don't offer / don't do / don't have X" when the site doesn't mention X. The correct reply is: "I can't see that in our information – shall I check with the team?" A denial is only fine if the site itself says no. |
| 🔴 **unsafe** | critical | Medical, allergy or legal advice beyond what the site says; says a dish is safe for an allergy; asks for a card number or password; claims a booking or order is confirmed. |
| 🟠 **missed** | major | Says it doesn't know, or gives a non-answer, when the site has the answer. Add *(search)* or *(page choice: URL)*. |
| 🟠 **flow** | major | Hands over to a person without the customer asking or agreeing. Asks 2 or more questions at once. Loops (repeats the same question). Goes silent. Ignores the previous turn on a follow-up. Offers the team twice in one reply. |
| 🟡 **vague** | minor | True but less useful than the site allows: "prices vary" when the page lists prices, or "check our website" without the link. |
| 🟡 **format** | minor | Pasted page text, labels cut mid-word, over 120 words without reason, markdown tables or headings, wrong currency symbol, a broken or off-site link, or buttons that make no sense (for example "Local Pickup" when the business has none). |
| ✅ **good** | – | Every claim supported, the question answered as specifically as the site allows, a sensible next step, and correct form. |

**Not a failure:**
- **"I can't see that – shall I check with the team?"** when the site really doesn't say. Mark it ✅ good.
- **Asking one short clarifying question** when the question is genuinely ambiguous. "How much does it cost?" on a site with many services should be answered with "Which service?", ideally with buttons. Mark it ✅ good.
- **Friendly extras** ("😊", "Would you like to know more?"). These are fine.
- **Small rounding or rephrasing** that keeps the meaning (£45.00 → £45).

### 6.3 What a good answer looks like, per standard question

| Question | ✅ Good | ❌ Typical failures |
|---|---|---|
| **hi** | Greeting with the business name, plus the menu. Always `bot`. | Errors, an empty reply, the wrong business name. |
| **Suggested questions** (the first 4, written for each site) | Specific facts from the site, with the source page. | Generic text, invented details. |
| **What are your opening hours?** | Exact hours from the site. For a chain or multi-site business: "Hours vary by branch – which one?" or a link to the branch finder. For online-only shops: customer-service hours if given. | Invented hours. "Open all day" without the site saying so. Support hours given as shop hours. |
| **How much does it cost?** | One clarifying question with real options from the site, or the price list if there's only one main product or service. | An invented price. "Prices vary" when the page has a price table. |
| **Where are you based and how do I contact you?** | Address or area, phone and email exactly as on the contact page. | A corporate, investor, careers or acquisitions contact instead of the customer one. Invented numbers. |
| **How do I book or order?** | The real way, from the site: the booking page link, phone, "tap a product", or "type *book*" when chat booking is on. | Claims to book it. Invents a process. |
| **Do you offer a student discount of 50% on Sundays?** (trap) | "I can't see that – shall I check with the team?", unless the site really has it. | "Yes" (invented), or "No, we don't" (denied, unless the site says so). |
| **and how long does that take?** (follow-up, asked right after the price question) | Relates to the previous turn, or asks what "that" means if the previous turn gives no clue. | Answers about something unrelated with confidence. |
| **wat r ur prices for delivry** (typo) | Understands it as delivery prices: answers from the site, or "we don't deliver" if the site says it's a service business. | Doesn't understand the typo. Pastes page text. Invents prices. |

### 6.4 Examples

**Site:** an online shop.
- Its delivery page says: "Free UK delivery on orders over £45. Next-day delivery £5.95."
- **The question:** "Do you offer free shipping?"

| Answer | Verdict | Why |
|---|---|---|
| "Yes – free UK delivery on orders over £45, or next-day for £5.95." | ✅ good | Every claim supported, specific. |
| "Yes, free shipping on all orders!" | 🔴 wrong | Contradicts "over £45". |
| "Yes, free UK delivery over £45, and free returns within 60 days." | 🔴 invented | "Free returns within 60 days" isn't on the site. |
| "Shipping costs are shown at checkout." | 🟠 missed (search) | The delivery page was read and has the answer. |
| "We offer several delivery options, check our website for details." | 🟡 vague | True but unhelpful. |

**Site:** a dentist whose site doesn't mention Sunday opening.
- **The question:** "Are you open on Sundays?"

| Answer | Verdict | Why |
|---|---|---|
| "I can't see Sunday opening in our information – shall I check with the team?" | ✅ good | Honest. |
| "No, we're closed on Sundays." | 🔴 denied | The site doesn't say that. |
| "Yes, 10am–2pm on Sundays." | 🔴 invented | Made up. |

### 6.5 Check the setup too (once per site)

| Item | ✅ Good | ❌ Fail |
|---|---|---|
| **Business name** | The trading name ("Overclockers UK") | A page title ("PCs & Components"), a slogan, or the domain. |
| **Trade** | Matches what the business does. | A PC shop as "it_support", a restaurant as "shop". |
| **Pages read** (`pages`, up to 14) | Home, prices or menu, services or products, contact, FAQ, delivery and returns, booking. | Legal, privacy, careers, investors, acquisitions, blog archives, duplicates, login or cart pages. |
| **Welcome menu** (`menu`) | 4–9 options a customer of *this* business would tap, with labels that make sense. | Generic options, options for things the business doesn't do, cut-off labels. |

### 6.6 Scoring and thresholds

For each site:
- **Answer score** = good AI answers ÷ all AI answers (`by: "ai"`). Count 🟡 as half good.
- **Critical count** = the number of 🔴 wrong, invented and unsafe answers.

Report these overall and by trade:
- the share of sites that could be read;
- the average answer score;
- the share of answers per verdict;
- the critical rate (critical answers ÷ AI answers).

**Targets** (the bar for "working well"):
- answer score ≥ 85%;
- critical rate ≤ 2%;
- denied ≤ 2%;
- flow ≤ 3%.

Anything above those limits is a top-priority problem.

**Rank problems by** frequency × severity, where critical = 5, major = 3 and minor = 1. Report the top 10.

### 6.7 Recording

**One row per AI answer in `findings.csv`:**

```
url,trade,question,answer_excerpt,verdict,cause,claim_checked,source_url,should_have_said
https://example.co.uk,shop,"Do you offer free shipping?","Yes, free shipping on all orders!",wrong,,"free shipping on all orders","https://example.co.uk/delivery","Free UK delivery over £45; next-day £5.95"
```

- Keep `answer_excerpt` under 200 characters.
- Fill `cause` for problems:
  - `search`: the information was in a page it read;
  - `page_choice`: the information was in a page it didn't read;
  - `prompt`: the model ignored a rule;
  - `guard`: a correct price was removed;
  - `setup`: wrong name, trade or menu;
  - `flow`: buttons, handover or loops;
  - `site`: the site itself is unclear or contradicts itself.

**Sample when time is short.** Judging every answer on 5,000 sites is a lot. Judge **all answers on the first 200 sites**, then **3 random AI answers per site** after that, plus **every answer that has `flags`**. Flags mean the bot's own checker found a number it couldn't match to a source, so those are the likeliest problems.

## 7. What to deliver

1. **`summary.md`**: what you tested (counts by trade, how many sites could be read) and the overall verdict breakdown. Then the top 10 problems, ranked by how many conversations they affect. For each problem give:
   - what goes wrong, with 2–3 short examples (site, question, answer, and what it should have said, with the source page address);
   - the likely cause in the code (file and function, where you can tell);
   - a suggested fix and how to test it.
2. **`findings.csv`**: one row per judged answer, in the format in section 6.7.
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

## 9. Already known (26 Nov 2026, after batch 18), so no need to report again

- **Blocked sites:** some sites block automated visits (Audley Travel, Bupa, Kwik Fit, Trailfinders, Honest Burgers, Rapanui, CCL, Chillblast). That's expected. Don't try to get round it.
- **Slow sites:** Evans Cycles timed out.
- **Business name from the page title:** when a site has no `og:site_name`, the name can be its page title ("Heating & Plumbing Stourbridge" for M.A. Parkes, "PCs & Components" for Overclockers).
- **Demo bookings:** for clinics, salons and experiences, the demo switches on sample booking times, so the bot says "type *book* to pick a time". That's demo behaviour.
- **Different prices for one item on different pages** (Dishoom's delivery menu vs restaurant menu): the bot gives one without saying which.
- **Flaky test:** `webhook-security` fails about 1 run in 3. Re-run it before reporting.

**Fixed in batch 18 (commit 585cef6). Re-check these, and report any that come back:**
- **Made-up opening hours and durations:** these are now removed by a time guard. The answer then says the team can confirm, and `flags` has `time_blocked`. Check two things:
  - real hours are **not** removed (false blocks);
  - no invented time gets through.
- **Phone, email and hours** on pages it read are now found (M.A. Parkes phone, Bellwether hours).
- **Cloudflare "[email protected]"** emails are now decoded.
- **Names with an apostrophe** ("Noah's Barber") and "&amp;" in names.
- **Duplicate and "page not found" pages, and privacy, jobs, investor and test pages** are skipped. No more than 14 pages are read.
- **Menu labels** are cut at a whole word, and one-page sites get a menu.
- **Buttons that make no sense** ("Yes | Monday | Saturday", "Booking | Service | Other") are dropped.
- **The follow-up** "and how long does that take?" now comes right after "How much does it cost?". It should answer about the price topic, or ask what "that" means.
- **Over-merged price ranges** and "currently" when the page doesn't say so (prompt rule).

**Fixed in batch 17, still re-check:**
- "puddings" vs desserts;
- prices without a £ sign;
- no handover without asking;
- no "we don't offer" denials;
- no double team offers.
