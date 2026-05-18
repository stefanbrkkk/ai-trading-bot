# Phase 5: Strategic Architecture and Regulatory Compliance Framework for Project Aurelius

**CLASSIFICATION:** STRICTLY CONFIDENTIAL - INTERNAL ENGINEERING & LEGAL MANDATE

**AUTHOR:** Chief Compliance Officer & Lead Product Manager

**OBJECTIVE:** Evade Registered Investment Adviser (RIA) classification, guarantee FINRA 15c3-5 API compliance, shield the LLC from Black Swan liability, and execute a high-margin $200/mo SaaS funnel.

This document dictates the absolute legal boundaries and exact software engineering constraints for Project Aurelius. Non-compliance with these directives will result in immediate termination of code deployments. We are building a high-frequency algorithmic routing interface, not a regulated fiduciary service. Read these mandates, code them into the system architecture, and enforce them without exception.

## 1. The "Neutral Tool" SEC Legal Shield

Our paramount legal objective is evading classification as an RIA under the Investment Advisers Act of 1940. To achieve this, the platform must perfectly invoke the **Publisher’s Exemption** (*Lowe v. SEC*) and operate strictly as a **Neutral Tool**. We are an objective data processor, a "window, not a hand on the wheel."

If the system makes an investment decision on behalf of a user, we become an unregistered investment adviser and face catastrophic SEC enforcement.

### UI/UX & Backend Mechanical Limiters (DOs & DON'Ts)

* **PROHIBITED: Auto-Execution & Global Toggles:** The AI **CANNOT** auto-execute by default. You will not code a "trade while I'm away" toggle. The backend API routing microservices must not contain cron jobs or autonomous event listeners that trigger routing endpoints based on the AI model's pipeline completion.
* **PROHIBITED: Algorithmic Position Sizing:** The AI must **NEVER** analyze a user’s connected brokerage balance to suggest a position size (e.g., "Allocate 5% of your portfolio to this pick"). This violates the impersonal nature of the Publisher's Exemption.
* **PROHIBITED: Digital Engagement Practices (DEPs):** Eradicate all gamification. No digital confetti, no leaderboards, no push notifications urging immediate action. The UI must function with the sterile, objective neutrality of a Bloomberg Terminal.
* **MANDATORY: Blank Input Fields:** The input fields for quantity, notional value, and limit price must default to null or 0. The user **MUST** physically type the desired allocation using their keyboard.
* **MANDATORY: Explicit Affirmative Action:** Every single API call to POST /v2/orders must be initiated by a verified HTTP request originating from a client-side user session, triggered by the user physically clicking "Execute."
* **MANDATORY: Order Type Selection:** The user must explicitly select the order type (Market, Limit, Stop) from a dropdown menu. The system must not default to a Market order.

## 2. Systemic Risk & FINRA 15c3-5 Parallels

Although we are not a broker-dealer, our API partners (Interactive Brokers, Alpaca) are strictly governed by FINRA Rule 15c3-5 (The Market Access Rule). If our routing logic spams their APIs with erroneous orders, they will instantly sever our API keys and destroy our business model. We must engineer prophylactic internal risk controls that parallel FINRA requirements.

### The Dedicated Risk Engine Architecture

Backend engineers must build an intermediate validation microservice (the Risk Engine) that intercepts and evaluates every user API request *before* it transmits to the downstream brokerage.

* **Fat-Finger Limiters (Notional Ceilings):** Hardcode a maximum allowable dollar amount per single order. If a user accidentally types "$5,000,000," the internal risk engine must reject the payload instantly.
* **Liquidity Constraints:** The Risk Engine must evaluate the requested share quantity against the security’s 30-day Average Daily Volume (ADV). Reject any order exceeding 5% of the ADV to prevent exchange-level circuit breakers and market manipulation flags.
* **Price Tolerance Boundaries:** For Limit orders, evaluate the inputted limit price against the National Best Bid and Offer (NBBO). Reject orders with prices wildly disconnected from the prevailing market to prevent catastrophic executions.
* **Pre-Trade Margin Checks:** The platform must query the broker API (GET /v2/account) in real-time. If an order would create an intraday margin deficit, the UI must intercept the submission and display an "Insufficient Funds" error. Do not send destined-to-fail orders to the broker.
* **The Global Kill Switch:** You must engineer an administrative dashboard mechanism that instantaneously halts all outbound API order routing. When triggered, it must sever active API POST connections, reject all incoming user requests with a 503 status, and attempt to cancel pending orders. This must execute without a code deployment or server reboot.

## 3. Litigation Protection in Black Swan Events

Financial markets fail. APIs time out. Algorithms hallucinate. When a flash crash occurs and a failed stop-loss costs a user $50,000, they will attempt to sue the LLC. Our Terms of Service and database architecture must provide an impenetrable defense, allowing us to win summary dismissals in mandatory arbitration.

### Contractual Defenses & Clickwrap Mechanics

* **MANDATORY: Strict Clickwrap Flow:** Browsewrap (footer links) is legally useless. Users must be forced to scroll to the absolute bottom of the Terms of Service window before a checkbox becomes clickable.
* **Indemnification & Limitation of Liability:** The Terms must explicitly disclaim liability for third-party API failures, network latency, and software bugs. Aggregate liability for any claim must be contractually capped at the total subscription fees paid by the user in the trailing three (3) months.
* **Mandatory Arbitration & Class Action Waiver:** Users must waive their right to a jury trial and agree to individual, binding arbitration. This prevents a localized API failure from morphing into a multi-million-dollar class-action lawsuit.
* **Explicit AI Risk Disclosures:** The user must explicitly acknowledge that AI systems are subject to "hallucinations," data lag, and logic failures, and that the value of any traded security can go to zero.

### Bitemporal Database Immutability (The Audit Trail)

A standard SQL database where records can be UPDATED or DELETED will be shredded by a plaintiff's attorney in discovery.

* **Append-Only Postgres JSONB Schema:** Deploy a bitemporal ledger system. Use entity\_facet\_snapshots for baseline states and entity\_facet\_deltas for JSON Patch operations. Data must never be overwritten.
* **Forensic Telemetry:** To legally prove the platform acted strictly as a Neutral Tool and did not auto-execute, every routed order must permanently log:
  1. The exact **Cryptographic SPIFFE ID** of the authorizing internal microservice.
  2. **Millisecond-precision timestamps** tracking the user click vs. API transmission vs. broker acknowledgment.
  3. The initiating **IP Address & Browser User-Agent**.
  4. **UI Coordinate Click-Logs** (exact X/Y cursor coordinates proving physical human intent).
  5. The **Raw JSON Payload** dispatched to the broker API.
  6. The exact **Broker HTTP Status** and response payload (e.g., proving the broker returned a 503 error, not our system).

## 4. The SaaS Monetization & Onboarding Funnel

To fund a Tier-1 quantitative execution environment (cloud compute, low-latency market data feeds, LLM API costs), we must aggressively filter out low-value retail users and isolate high-capital, high-intent traders capable of subsidizing our infrastructure.

### Phase 1: The Paper Trading Sandbox (Psychological Hook)

Users will enter the platform through a zero-cost Paper Trading Sandbox powered by the Alpaca API.

* **The Strategy:** Force users to interact with the AI's "Top 5" daily picks in a simulated environment. This builds psychological trust in the algorithm's predictive alpha without exposing the user to financial risk or the platform to execution liability.
* **The Hook:** Users watch simulated profits accumulate over a 14-day trial period, establishing the platform's value proposition.

### Phase 2: The Premium Execution Paywall

To unlock live API execution routing (Interactive Brokers OAuth, Alpaca Live), the user hits a hard paywall.

* **The Pricing:** **$200/month** strictly enforced via Stripe billing.
* **The Business Rationale:** \* **Filtration of Low-Capital Traders:** A $200/month subscription requires a user to have a substantial underlying portfolio (e.g., $50,000+) to mathematically justify the software cost. This inherently filters out novice retail traders trading with $500 accounts—the exact demographic most likely to panic, file frivolous SEC complaints, or initiate chargebacks over minor market losses.
  + **Margin Protection:** High-frequency API polling and machine learning compute costs are expensive. A premium pricing model guarantees high margins per user, rather than attempting to monetize a massive volume of low-tier users which scales infrastructural risk linearly without equivalent financial upside.
  + **Intent Verification:** Paying a premium fee serves as an additional layer of verifiable user intent, further strengthening our legal defense that the user is a sophisticated, self-directed actor knowingly utilizing an advanced technological tool.