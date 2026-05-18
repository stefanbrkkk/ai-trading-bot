# Project Aurelius: Phase 3 Infrastructure Blueprint

**Author:** Chief Technology Officer / HFT Cloud Architect

**Objective:** Architecting a deterministic, multi-tenant cloud environment for algorithmic order routing with sub-150ms tick-to-trade latency.

## 1. Network Topography & Colocation

In algorithmic high-frequency environments, physical geography dictates determinism. Retail cloud architectures fail because they ignore the refractive index of silica fiber optics; every 100 kilometers of geographical distance inherently introduces roughly 1 millisecond of minimum round-trip time (RTT), exacerbated exponentially by multi-hop routing switches. To achieve sub-150ms execution, Project Aurelius mandates a dual-pronged, bare-metal colocation strategy tailored to specific brokerage ecosystems.

* **Interactive Brokers (IBKR) & US Equities:** Our primary routing for US equities and options requires bare-metal nodes physically colocated within the **Equinix NY4** financial data center in Secaucus, New Jersey. This places our computational servers in the exact same facility as IBKR’s East Coast matching gateways (ndc1.ibllc.com). By bypassing the public internet and utilizing direct cross-connects, we reduce our network transit ping from a standard retail ~40ms down to a highly deterministic **1ms-2ms**.
* **Alpaca Execution Gateways:** Alpaca’s architecture bifurcates market data and account processing. While their Securities Information Processor (SIP) resides in New York, their order execution infrastructure is hosted on Google Cloud Platform (GCP). To optimize our tick-to-trade lifecycle with Alpaca, we will deploy our secondary execution cluster strictly within **GCP us-east4** (Northern Virginia). This drastically minimizes the network transit time to Alpaca's backend, bridging the gap between signal generation and order fill.

Across both locations, our bare-metal deployment will utilize Single-Root Input/Output Virtualization (SR-IOV) and SO\_BUSY\_POLL socket options to poll the Network Interface Card (NIC) directly, entirely bypassing kernel interrupt handling context switches.

## 2. Protocol & Latency Mitigation

The very concept of using Representational State Transfer (REST) protocols to poll the broker for market data or execute high-frequency trades is an architectural anti-pattern. Standard HTTP GET/POST loops require repetitive Domain Name System (DNS) lookups, 3-way TCP handshakes, and cryptographic Transport Layer Security (TLS) negotiations. This generates immense computational bloat, inevitably causing pacing violations and severe latency spikes.

* **Market Data Ingestion:** To eliminate network jitter and bypass rate limits entirely, Project Aurelius will rely strictly on persistent, bidirectional **WebSockets** for consuming the National Best Bid and Offer (NBBO) and SIP feeds. WebSockets maintain a full-duplex TCP connection, transforming our ingestion pipeline into a push-based model. We will isolate the WebSocket connections to dedicated CPU cores, ensuring that incoming price ticks are ingested the exact millisecond they are generated on the exchange, completely unobstructed by outgoing execution payloads.
* **Order Routing:** Where possible, REST will be abandoned in favor of the Financial Information eXchange (FIX) protocol or highly multiplexed asynchronous TCP connector pools, bypassing HTTP header overhead.

## 3. The Concurrency Pipeline (Kafka to Broker)

The journey of a signal from our machine learning engine to the brokerage requires a highly synchronized pipeline capable of fanning out data to multiple temporal agents while safely managing hundreds of multi-tenant API executions.

* **Durable Ingestion:** Raw tick data is funneled into **Apache Kafka**, which acts as our distributed, order-preserving ledger. To prevent JVM pause-time outliers that destroy determinism, the Kafka brokers are strictly tuned using the Z Garbage Collector (ZGC). We configure the brokers with acks=all and enable.idempotence=true to guarantee data safety without sacrificing our sub-5ms p99 latency target.
* **Ephemeral Fanout:** For ultra-fast intra-node communication, the tick data bypasses JSON parsing and is pushed via **Redis Pub/Sub** to our concurrent machine learning workers, operating purely on string byte manipulation to achieve median write latencies of 2.1ms.
* **Execution & Mechanical Sympathy:** When a signal is generated, the system must process trades for hundreds of clients concurrently. Standard multithreading creates lock contention. Instead, we utilize the **LMAX Disruptor**—a lock-free, single-writer, multi-reader ring buffer. The Disruptor enforces "mechanical sympathy" by preventing CPU false-sharing.
* **Bulk Order Allocation:** To prevent crashing into IBKR’s 50 messages/second limit or Alpaca’s 200 requests/minute limit, the LMAX Disruptor aggregates the multi-tenant signals into a single, massive parent block order. We transmit this singular order using IBKR Financial Advisor (FA) profiles or Alpaca’s OmniSub API. The brokerage's internal memory space—not our network layer—handles the sub-account division, allowing us to simultaneously execute hundreds of API actions via a single network payload.

## 4. Multi-Tenant Security & API Key Management

Retrieving API credentials during a high-volatility threshold event introduces fatal I/O blocking. We cannot afford a standard database query in the middle of our 150-millisecond execution budget.

To securely manage the diverse array of client API keys without compromising speed, we utilize **Neon Serverless Postgres**.

1. **Secure Storage:** All user credentials, Alpaca API keys, and IBKR session tokens are encrypted at rest using AES-256 within the Neon Postgres database.
2. **Memory Pooling & Dynamic Retrieval:** When the system initializes, or specifically when the AI engine calculates a macro-volatility event is imminent, a dedicated asynchronous worker preemptively queries Neon.
3. **Zero-Allocation Execution:** The keys are decrypted and loaded into a pre-warmed, zero-allocation memory pool directly linked to the LMAX Disruptor execution consumer. When the mathematical threshold is breached, the execution thread accesses the authenticated socket pool from RAM in nanoseconds, instantly authorizing the bulk FIX payload over the wire.

This architecture guarantees institutional-grade security for our users while maintaining absolute, unyielding adherence to our deterministic execution parameters.