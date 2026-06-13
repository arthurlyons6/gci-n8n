# GCI Financial - Forked Platform Repositories

This directory contains 5 forked repositories customized for **GCI Financial** - a faith-based digital banking platform.

## 🏦 GCI Financial Overview

**Mission**: Ship GCI Financial as a live faith-based digital bank with accounts, loans, church programs, and AI assistant powered by NexaBaaS on Railway.

**Live Platform**: https://nexabaas-platform-production.up.railway.app

**Brand Tokens** (LOCKED):
- Navy: `#04060E`
- Gold: `#EEC050`
- Cream: `#F2E8D0`
- Green: `#3DDB78`
- Red: `#F07070`
- Violet: `#A78BFA`

**Fonts**: Fraunces (display) / Inter (body) / JetBrains Mono (code)

---

## 📦 Forked Repositories

| Repository | Fork | Purpose | GCI Customizations |
|------------|------|---------|-------------------|
| **n8n-io/n8n** | `gci-n8n` | Workflow automation core | 5 custom nodes: KYC Check, Church Tithe, Church Budget, Loan Approval, SAR Filing |
| **langgenius/dify** | `gci-dify` | GenAI platform | GCI knowledge base, agent templates for KYC, loan underwriting, church treasurer workflows |
| **nocodb/nocodb** | `gci-nocodb` | Admin panels / Airtable alt | Schema: members, accounts, transactions, churches, kyc_records, aml_alerts; Treasurer dashboards |
| **windmill-labs/windmill** | `gci-windmill` | Dev platform / Infra as code | Scripts: daily-compliance-check, kyc-refresh, sar-generator; TypeScript/Go for performance |
| **appsmithorg/appsmith** | `gci-appsmith` | Internal tools / Admin panels | Dashboards: Member 360, Church Treasurer, Compliance Officer, Ops Console |

---

## 🚀 Quick Start

### Prerequisites
- Docker Desktop (4GB+ RAM, 4+ CPUs)
- Node.js 22+ (for n8n/Dify)
- pnpm 10+
- Rust (for Windmill/Appsmith)

### Local Development

```bash
# Clone all forks (already done)
cd ~/gci-forks
ls -la  # Should show: gci-n8n gci-dify gci-nocodb gci-windmill gci-appsmith

# Start full stack with Docker Compose
cd gci-configs
docker-compose -f docker-compose.gci.yml up -d

# Verify services
docker-compose -f docker-compose.gci.yml ps
```

### Service URLs (Local)

| Service | URL | Credentials |
|---------|-----|-------------|
| **n8n** | http://localhost:5678 | admin / gci_admin_pwd |
| **Dify** | http://localhost:8080 | admin@gci.local / gci_admin_pwd |
| **NocoDB** | http://localhost:8081 | admin@gci.local / gci_admin_pwd |
| **Windmill** | http://localhost:8082 | admin@gci.local / gci_admin_pwd |
| **Appsmith** | http://localhost:8083 | admin@gci.local / gci_admin_pwd |
| **PostgreSQL** | localhost:5432 | gci_user / gci_postgres_pwd |
| **Redis** | localhost:6379 | - |
| **MinIO** | http://localhost:9001 | gci_admin / gci_minio_pwd |

---

## 🔧 GCI Customizations

### n8n Custom Nodes (`gci-n8n/packages/nodes-base/nodes/`)

```
GciKycCheck/      # KYC verification, sanctions screening, risk scoring
GciChurchTithe/   # Process tithes, offerings, recurring pledges, receipts
GciChurchBudget/  # Create budgets, allocations, variance analysis, approvals
GciLoanApproval/  # Loan applications, underwriting, approval, funding, monitoring
GciSarFiling/     # SAR creation, auto-generation, FinCEN submission, tracking
```

Each node includes:
- TypeScript implementation following n8n conventions
- GCI-branded SVG icon
- PostgreSQL credential integration
- Church-specific fields (tithe types, church budgets, etc.)

### Dify Customizations (`gci-dify/`)

- **Knowledge Base**: GCI compliance docs, KYC rules, BSA/AML procedures
- **Agents**: KYC Processor, Loan Underwriter, Church Treasurer Assistant, Compliance Monitor
- **Workflows**: Member onboarding, church giving processing, alert triage

### NocoDB Schemas (`gci-nocodb/`)

```sql
-- Core tables mirroring GCI PostgreSQL schema
members, accounts, transactions, churches, church_giving,
church_budgets, recurring_pledges, kyc_records, aml_alerts,
sar_filings, cards, loans, denomination_admins, audit_log,
push_subscriptions, early_deposit_enrollments, roundup_giving,
savings_goals, joint_account_invites, leads
```

### Windmill Scripts (`gci-windmill/`)

- `daily-compliance-check` - Runs KYC refresh, AML scanning, SAR deadline checks
- `kyc-refresh` - Periodic KYC re-verification for high-risk members
- `sar-generator` - Auto-generates SARs from AML alert clusters

### Appsmith Dashboards (`gci-appsmith/`)

- **Member 360**: Complete member profile, accounts, transactions, KYC status
- **Church Treasurer**: Giving reports, budget variance, pledge tracking
- **Compliance Officer**: AML alerts, SAR queue, risk dashboard
- **Ops Console**: System health, deployment status, audit log

---

## 🔄 Weekly Upstream Sync

```bash
# Run sync for all forks
cd ~/gci-forks
./sync-all.sh

# Or run individual sync
cd ~/gci-forks/gci-n8n
git fetch upstream
git merge upstream/main --allow-unrelated-histories -m "Sync upstream $(date +%Y-%m-%d)"
git push origin main
```

**Automated**: GitHub Actions workflow runs every Sunday 2 AM UTC (`.github/workflows/gci-sync.yml`)

---

## 🚀 Deployment to Railway

Each fork has its own Railway service. Configure these secrets in GitHub:

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `RAILWAY_TOKEN` | Railway API token |
| `RAILWAY_PROJECT_ID` | Railway project ID |
| `RAILWAY_N8N_SERVICE_ID` | n8n service ID |
| `RAILWAY_DIFY_API_SERVICE_ID` | Dify API service ID |
| `RAILWAY_DIFY_WEB_SERVICE_ID` | Dify Web service ID |
| `RAILWAY_NOCODB_SERVICE_ID` | NocoDB service ID |
| `RAILWAY_WINDMILL_SERVICE_ID` | Windmill service ID |
| `RAILWAY_APPSMITH_SERVICE_ID` | Appsmith service ID |
| `SLACK_WEBHOOK_URL` | Failure notification webhook |

### Railway Environment Variables (per service)

```env
# n8n
N8N_HOST=gci-n8n.railway.app
N8N_PROTOCOL=https
DB_TYPE=postgresdb
DB_POSTGRESDB_HOST=${{RAILWAY_PRIVATE_DOMAIN}}
DB_POSTGRESDB_DATABASE=gci_n8n
N8N_ENCRYPTION_KEY=***
N8N_BASIC_AUTH_ACTIVE=true

# Dify
DATABASE_URL=postgresql://...
SECRET_KEY=***
WINDMELL_API_URL=https://gci-windmill.railway.app

# NocoDB
NC_DB=postgresql://...
NC_PUBLIC_DOMAIN=https://gci-nocodb.railway.app

# Windmill
DATABASE_URL=postgresql://...
BASE_URL=https://gci-windmill.railway.app

# Appsmith
APPSMITH_DATABASE_URL=postgresql://...
APPSMITH_REDIS_URL=redis://...
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      GCI Financial Platform                      │
├─────────────────────────────────────────────────────────────────┤
│  Member App (/app)     Church Portal (/church)  Denomination    │
│  Ops Console (/console)  Pitch (/pitch)      Closed Loop (/flow)│
└──────────────────────────────┬──────────────────────────────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         ▼                     ▼                     ▼
    ┌─────────┐           ┌─────────┐           ┌─────────┐
    │  n8n    │───────────│  Dify   │───────────│ Windmill│
    │Workflow │   MCP     │  GenAI  │   MCP     │  Infra  │
    └────┬────┘           └────┬────┘           └────┬────┘
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────────────────────────────────────────────────────┐
    │           PostgreSQL (gci_* databases)                  │
    │  members │ accounts │ transactions │ churches │ kyc... │
    └─────────────────────────────────────────────────────────┘
         │                     │                     │
         ▼                     ▼                     ▼
    ┌─────────┐           ┌─────────┐           ┌─────────┐
    │ NocoDB  │           │Appsmith │           │ MinIO   │
    │ Admin   │           │Dashboards│          │ Files   │
    └─────────┘           └─────────┘           └─────────┘
```

---

## 📋 Development Workflow

### 1. Create Feature Branch
```bash
cd ~/gci-forks/gci-n8n
git checkout -b feature/gci-kyc-enhancement
```

### 2. Make Changes
- Add/modify custom nodes
- Update schemas
- Write tests

### 3. Test Locally
```bash
# In gci-configs
docker-compose -f docker-compose.gci.yml up -d
# Test your changes
```

### 4. Commit & Push
```bash
git add .
git commit -m "feat(gci): enhance KYC check with church leadership level"
git push origin feature/gci-kyc-enhancement
```

### 5. Create PR
- PR triggers CI/CD pipeline
- Auto-deploys to Railway on merge to main
- Weekly upstream sync keeps forks current

---

## 🔐 Security

- **No secrets in code** - All credentials via Railway/GitHub secrets
- **Money in cents** - All financial amounts stored as integers
- **Audit logging** - Every change tracked in `audit_log` table
- **KYC/AML** - Built into workflow nodes
- **SAR filing** - Automated FinCEN BSA E-Filing integration

---

## 📚 Documentation

- [GCI Brand Guidelines](GCI_BRANDING.json)
- [Database Schema](init-sql/01-gci-schema.sql)
- [Docker Compose](docker-compose.gci.yml)
- [Sync Script](sync-all.sh)
- [CI/CD Workflows](.github/workflows/)

---

## 🤝 Contributing

1. Fork the relevant GCI repository
2. Create feature branch
3. Follow GCI coding standards (TypeScript, Rust, SQL)
4. No emojis - use inline SVGs only
5. Money always in cents
6. Submit PR with description of GCI-specific changes

---

## 📄 License

Each fork retains its original license (MIT, Apache 2.0, AGPL, etc.) with GCI customizations under the same terms.

---

**Built with ❤️ for GCI Financial** - Faith-based banking for the modern church.