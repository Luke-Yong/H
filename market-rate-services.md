# Market Rate for Services

Rates below are in **SGD** and reflect the Singapore market (SGT). All figures are indicative benchmarks; actual rates depend on scope complexity, timeline, and engagement model (project-based vs. retainer).

---

## 1. Full Stack Development

### Scale & Scope

| Scale | Duration | Description |
|-------|----------|-------------|
| **Small** | 2–6 weeks | Landing pages, internal dashboards (single module), simple CRUD APIs, static sites with CMS backends. |
| **Mid** | 2–6 months | Multi-tenant SaaS modules, admin portals, real-time dashboards, API gateways with auth, mobile-first PWAs. |
| **Large** | 6–18 months | Enterprise platforms (multi-service, role-based access), marketplace/multi-vendor systems, end-to-end digital transformation. |

### Typical Cost by Stack (Mid-Scale Reference)

| Stack | Technologies | Indicative Cost (SGD) | Notes |
|-------|-------------|----------------------|-------|
| **React + Node/Express + PostgreSQL** | TypeScript, REST/GraphQL, Prisma/Knex | $50K–$150K | Most common startup stack; fast iteration. |
| **React + Python (FastAPI/Django) + PostgreSQL** | TypeScript, Python, Celery, Redis | $60K–$180K | Better for data-heavy or ML-adjacent apps. |
| **React + .NET (C#) + SQL Server** | ASP.NET Core, Entity Framework, Azure | $80K–$220K | Enterprise/ gov-facing; higher licensing & hosting overhead. |
| **React Native / Flutter + Backend** | Cross-platform mobile + any backend | $70K–$200K | Add ~30–50% premium over web-only. |
| **Electron + React + Node** | Desktop app (Windows/macOS/Linux) | $80K–$250K | Niche skill set; higher testing & distribution complexity. |

### Rate Models

- **Hourly:** $80–$150/hr (senior full stack, Singapore)
- **Monthly retainer (full-time equivalent):** $12K–$22K/mo
- **Fixed-price:** Add 20–30% contingency over time-and-materials estimate

---

## 2. Disruption Routing

Specialised public-transport disruption intelligence service combining **RAPTOR-based point-to-point routing** with **LTA DataMall real-time disruption detection**.

### Core Capabilities

| Capability | Description |
|------------|-------------|
| **RAPTOR Routing Engine** | Multi-criteria transit routing (time, transfers, walking distance). Supports GTFS-static schedules with dynamic recalculation on disruption events. |
| **LTA DataMall Integration** | Real-time bus arrival, train service alerts, carpark availability, traffic images. Polling + webhook-style event processing pipeline. |
| **Disruption Detection** | Anomaly detection on ETA drift, missing trips, service status API flags. Configurable thresholds with false-positive suppression. |
| **Alternative Routing** | Automatic re-routing on detected disruption. Suggests alternative stations, bus bridging, or mode-shift (MRT ↔ bus). |

### Indicative Cost

| Engagement | Scope | Cost (SGD) |
|------------|-------|-------------|
| **Proof of Concept** | Single transit line, RAPTOR prototype, DataMall polling | $25K–$45K |
| **Production System** | Full Singapore network (MRT + LRT + bus), real-time disruption pipeline, web/mobile UI | $80K–$180K |
| **Ongoing Maintenance** | GTFS schedule updates, API changes, model retuning | $3K–$6K/mo |

### Hourly Rate

- $100–$180/hr (specialised domain: transit algorithms + real-time data engineering)

---

## 3. AI Feature Integration

End-to-end integration of AI/LLM capabilities into existing products — from architecture to production operations.

### Skills & Coverage

| Skill Area | What It Covers |
|------------|----------------|
| **Harness Engineering** | Multi-agent orchestration, sub-agent delegation, tool-use frameworks, streaming SSE pipelines, agent memory (SQLite/vector DB). Design of parent/child agent architectures with tool access control. |
| **Model Selection** | Evaluate and benchmark LLMs across cost/latency/accuracy trade-offs. Experience with DeepSeek, GPT-4o, Claude, Gemini, open-source models (Llama, Qwen). On-prem vs. cloud deployment analysis. |
| **Prompt Engineering** | System prompt design for constrained tool-use agents. Few-shot structuring, chain-of-thought reasoning patterns, structured output formatting (JSON mode, function-calling schemas). Iterative prompt evaluation and regression testing. |
| **RAG & Embeddings** | Retrieval-augmented generation pipelines, chunking strategies, hybrid search (semantic + keyword), embedding model selection and fine-tuning. |
| **AI Safety & Guardrails** | Output validation, content filtering, rate limiting, token budget enforcement, human-in-the-loop approval workflows. |
| **MLOps / LLMOps** | Model versioning, A/B evaluation, cost monitoring and token usage tracking, automated regression suites for prompt changes. |
| **Backend Integration** | Streaming endpoints (SSE/WebSocket), tool execution sandboxing, state machine-based agent loops, structured logging for agent audit trails. |

### Indicative Cost

| Engagement | Scope | Cost (SGD) |
|------------|-------|-------------|
| **AI Readiness Assessment** | Audit existing product, recommend AI integration points, architecture proposal | $8K–$18K |
| **Feature Prototype** | Single AI feature end-to-end (e.g., "AI code review assistant", "chat-with-your-data") | $25K–$60K |
| **Full Integration** | Multi-agent system, RAG pipeline, production deployment with monitoring | $80K–$200K |

### Hourly Rate

- $120–$200/hr (covers architecture, prompt engineering, agent design, and productionization)

---

## 4. Bug Hunting & Fixing

Systematic debugging of production issues, performance bottlenecks, and edge-case failures.

### Approach

- **Triage & Reproduce** — isolate root cause with minimal reproduction steps.
- **Scientific Debugging** — hypothesis → instrumentation → evidence collection → fix → regression test.
- **Tooling** — runtime log injection (debug server), browser console/network trace analysis, Electron main+renderer debugging, SQL query profiling, React component re-render analysis.

### Typical Bugs

| Type | Examples |
|------|----------|
| **Logic / State** | Stale closures, race conditions, incorrect state transitions, React re-render loops |
| **Concurrency** | SSE stream desync, WebSocket reconnect storms, terminal buffer corruption |
| **Performance** | Memory leaks (Node/Electron), slow SQL queries (missing indices, N+1), large DOM trees |
| **Integration** | API schema mismatches, auth token expiry not handled, CORS/network errors |
| **Platform** | Electron IPC failures, native module compilation, OS-specific path/encoding bugs |

### Rate Models

- **Hourly (ad-hoc):** $100–$160/hr
- **Bug Bounty (per fix):** $500–$5,000 depending on severity (P0 critical → P3 cosmetic)
- **Retainer (dedicated debugging bandwidth):** $6K–$12K/mo for 40–80 hrs

---

## 5. Small Neural Network Training & Inference

Training and deploying compact neural models for specialised, low-latency use cases.

### Scope

| Area | Examples |
|------|----------|
| **Tabular / Structured Data** | ETA prediction, demand forecasting, fraud/anomaly detection on time-series |
| **NLP (compact)** | Text classification, entity extraction, intent recognition for domain-specific chatbots |
| **Reinforcement Learning** | Small-scale decision optimisation (e.g., routing policy learning) |
| **On-Device Inference** | Model quantisation, ONNX/TensorFlow Lite export, edge deployment for latency-sensitive apps |

### Indicative Cost

| Engagement | Scope | Cost (SGD) |
|------------|-------|-------------|
| **Feasibility Study** | Data audit, baseline model, feasibility report | $8K–$18K |
| **Model Development** | Data prep, architecture selection, training, hyperparameter tuning, evaluation | $20K–$60K |
| **Production Deployment** | Inference API, model serving, monitoring (drift detection), retraining pipeline | $15K–$40K |

### Hourly Rate

- $100–$180/hr

---

## Rate Summary Table

| Service | Hourly (SGD) | Monthly Retainer | Project Range |
|---------|-------------|-----------------|---------------|
| Full Stack Development | $80–$150 | $12K–$22K | $20K–$250K |
| Disruption Routing | $100–$180 | $3K–$6K (maintenance) | $25K–$180K |
| AI Feature Integration | $120–$200 | Negotiable | $8K–$200K |
| Bug Hunting & Fixing | $100–$160 | $6K–$12K | $500–$5K (per fix) |
| Small Neural Network | $100–$180 | Negotiable | $8K–$100K |

> **Notes:** All rates in Singapore Dollars (SGD). Prices are indicative and assume senior-level delivery. Rush/premium timelines typically add 25–50%. Government/GLC clients may have additional compliance and procurement lead-time considerations.
