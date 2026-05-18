# Phase 2: Data Engineering & NLP Architecture (Project Aurelius)

**Author:** Lead Quantitative Data Engineer & Head of Machine Learning (NLP Division)

## 1. Alt-Data Scraping & Ingestion Pipelines

To acquire high-signal alternative data, our infrastructure must navigate an inherently adversarial environment.

* Our system bypasses sophisticated anti-bot defenses on platforms like Glassdoor and LinkedIn (which utilize Cloudflare, Akamai, and DataDome) by implementing TLS impersonation at the network layer.
* We utilize the curl\_cffi library, which invokes curl-impersonate internally to perfectly spoof the JA3/TLS cryptographic fingerprint of modern Chrome browsers.
* For zero-latency ingestion of legally mandated insider trading disclosures (SEC Form 4), the pipeline monitors SEC EDGAR RSS feeds.
* To parse these deeply nested XML documents without the bottlenecks of the Python Global Interpreter Lock, we deploy a systems programming architecture using Rust.
* Utilizing libraries built on the tokio asynchronous runtime allows us to process millions of filings with predictable latency.

## 2. Statistical Normalization & Temporal Decay

Raw unstructured data streams are dimensionally incompatible with high-frequency tick data and must be statistically mapped before execution.

* Traditional Gaussian normalization fails on alt-data; therefore, we utilize the Empirical Cumulative Distribution Function (ECDF).
* The ECDF transforms raw values into a uniform distribution strictly on the interval [0,1], completely neutralizing scale differences while preserving the exact rank-relationships of extreme events.
* To model the cross-sectional correlation and asymmetric tail dependencies between disparate streams (e.g., market downturns), we apply Canonical Vine (C-vine) copulas, which decompose the multi-dimensional joint probability density into a hierarchical tree structure.
* We mathematically enforce the reality of alpha decay using continuous exponential decay functions.
* High-noise streams like Reddit and social media sentiment are subjected to a steep exponential decay curve with a calibrated half-life of minutes to hours.
* Conversely, high-signal structural data, such as Form 4 Insider Trading accumulation, utilizes a one-step smoothed decay with a half-life of 30 to 90 days.

## 3. Enterprise Financial RAG Architecture

Transforming dense regulatory texts into actionable intelligence requires structural preservation prior to vector embedding.

* Standard enterprise RAG systems destroy the context of SEC 10-K filings through naive character splitting, a phenomenon known as the "shredder effect".
* We prevent this by executing Hierarchical Layout Parsing, first splitting documents into parent chunks based on markdown logical section headers, and then recursively into child chunks, ensuring metrics remain tied to their specific risk or management sections.
* During the retrieval phase, we apply a deterministic, authority-based re-ranking algorithm to prioritize audited truth over speculation.
* Official regulatory filings (SEC 10-K, 13F) are assigned a maximum authority weight multiplier of 1.0.
* General unverified social commentary and Twitter/X data are heavily discounted with an authority multiplier of 0.30.

## 4. LLM Taxonomy & Schema Enforcement

To completely eliminate LLM hallucinations and enforce strict data routing to the trading engine, our pipeline restricts generative creativity.

* We utilize the specialized "FinGround taxonomy" to deconstruct generated text into atomic, independently verifiable claims.
* This taxonomy rigorously checks Numerical, Temporal, Entity-Attribute, Comparative, Regulatory, and Computational factual alignment against the source text.
* To ensure the LLM strictly outputs a rigid JSON schema, we leverage API-level Structured Outputs that constrain token sampling strictly to the Abstract Syntax Tree of the target schema.
* At runtime, the JSON payload (containing the Sentiment Score and Explainable AI Thesis) is secured and type-checked using the Zod validation library.
* For the highest structural fidelity, we deploy models trained via reinforcement learning methodologies, such as ThinkJSON using the DeepSeek R1 framework.
* This forces the LLM to develop an internal "chain-of-thought," logically deducing schema population and self-checking field accuracy, ensuring the final output is flawlessly formatted and empirically grounded.