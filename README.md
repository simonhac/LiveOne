# LiveOne — Universal Solar Monitoring Platform

A modern, multi-user solar monitoring platform with flexible point-based monitoring architecture. Supports multiple inverter brands, energy retailers, and composite virtual systems through an extensible design.

## 🌟 Key Features

### Multi-User & Multi-System Architecture

- 👥 **Unlimited users** - Each user can monitor their own systems
- 🏠 **Multiple systems per user** - Monitor multiple sites from one account
- 🔐 **Secure authentication** - Enterprise-grade auth via Clerk
- 🎯 **Role-based access** - Owner and viewer roles
- 🆔 **System aliases** - URL-friendly identifiers for easy sharing

### Point-Based Monitoring

- 📊 **Flexible metrics** - Track any metric from any device (power, energy, SOC, temperature, etc.)
- 🔧 **Vendor-independent** - Unified monitoring interface across all systems
- 🏷️ **Custom labeling** - User-configurable point names, types, and groupings
- 📈 **Multi-device support** - Monitor complex systems with multiple inverters, meters, and sensors
- 🔄 **Composite systems** - Aggregate data from multiple physical systems into virtual systems

### Real-Time Monitoring

- ⚡ **Live power flow** - Solar, battery, load, and grid visualization
- 📊 **Interactive charts** - 5-minute, 30-minute, and daily resolutions
- 📈 **Historical data** - Automatic aggregation with time-series optimization
- 🔄 **Auto-refresh** - Updates when data becomes stale
- ⚠️ **Fault detection** - Real-time alerts and status indicators

### Professional Dashboard

- 📱 **Fully responsive** - Optimized for mobile, tablet, and desktop
- 🎨 **Modern UI** - Clean design with dark theme
- 📊 **Energy statistics** - Today, yesterday, and all-time summaries
- 🔀 **Power/Energy toggle** - Switch between kW and kWh views
- 🎯 **Point filtering** - View by subsystem, type, or custom groupings
- 🗺️ **Heatmap visualization** - View daily patterns and trends for any metric over time
- ⚡ **Amber pricing** - Real-time electricity pricing data synced every 30 minutes

### Admin Capabilities

- 🛠️ **System management** - Monitor all systems across all users
- 👤 **User administration** - View user access and system ownership
- 📊 **Storage analytics** - Database metrics and health monitoring
- 🔧 **Test connections** - Validate inverter service credentials
- 🔍 **Debug tools** - Session tracking and data quality monitoring

## 🔌 Supported Systems

LiveOne supports multiple data sources through a flexible point-based monitoring architecture:

| System Type            | Integration Method                                                      | Update Frequency          | Status     |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------- | ---------- |
| **Selectronic SP PRO** | Select.Live API                                                         | Real-time (1-min polling) | Production |
| **Enphase IQ**         | OAuth 2.0 API                                                           | 15-minute intervals       | Production |
| **Fronius**            | [FroniusPusher](https://github.com/simonhac/FroniusPusher) (push-based) | Real-time push            | Production |
| **Mondo Power**        | Direct API                                                              | Real-time                 | Production |
| **Amber Electric**     | Retailer API                                                            | 30-minute intervals       | Production |
| **Composite Systems**  | Virtual aggregation                                                     | Derived from sources      | Production |

**Composite Systems** allow you to create virtual systems that aggregate data from multiple physical systems. For example:

- Combine multiple Enphase systems at different locations
- Merge solar generation from different inverter brands
- Create property-wide energy views from multiple sub-systems

## 🏗️ Architecture

### Tech Stack

- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS
- **Backend**: Vercel Serverless Functions, Node.js
- **Database**: Turso (Distributed SQLite), Drizzle ORM
- **Cache**: Upstash Redis (via Vercel KV) for real-time point values
- **Authentication**: Clerk (Multi-user support)
- **Hosting**: Vercel (Global CDN)
- **Charts**: Chart.js with interactive features
- **Data Collection**: Vercel Cron jobs (1-minute intervals)

### Extensible Design

```
┌─────────────┐  ┌──────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Selectronic │  │   Enphase    │  │   Fronius   │  │    Mondo    │  │    Amber    │
│ Select.Live │  │  OAuth 2.0   │  │FroniusPusher│  │  Direct API │  │ Retailer API│
│   (poll)    │  │   (poll)     │  │   (push)    │  │   (poll)    │  │   (poll)    │
└──────┬──────┘  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
       │                │                 │                │                │
       └────────────────┼─────────────────┼────────────────┼────────────────┘
                        │                 │                │
               ┌────────▼─────────────────▼────────────────▼────────┐
               │         Point-Based Monitoring Layer               │
               │  (Vendor-independent flexible metric storage)      │
               └────────┬───────────────────────────────────────────┘
                        │
               ┌────────▼─────────────────────────────────────┐
               │       Composite System Aggregation           │
               │  (Virtual systems from multiple sources)     │
               └────────┬─────────────────────────────────────┘
                        │
               ┌────────▼─────────────────────────────────────┐
               │          LiveOne Core (Next.js App)          │
               └──────────────────┬───────────────────────────┘
                                  │
           ┌──────────────────────┼──────────────────────┬──────────────────────┬──────────────────────┐
           │                      │                      │                      │                      │
     ┌─────▼─────────┐  ┌─────────▼────────┐  ┌─────────▼────────┐  ┌─────────▼────────┐
     │Turso Database │  │ Upstash Redis    │  │  Clerk Auth      │  │ Vercel Cron      │
     │(Time-series)  │  │ (Latest values)  │  │  (Multi-user)    │  │ (Data polling)   │
     └───────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘
```

## 📦 Installation

### Prerequisites

- Node.js 18+ and npm
- Clerk account (free tier works)
- Turso database account (free tier available)
- Upstash Redis (via Vercel KV integration) for caching (optional but recommended)
- Vercel account for deployment (free tier works)
- Access credentials for your inverter/energy system

### Local Development

1. **Clone the repository**

```bash
git clone https://github.com/simonhac/liveone.git
cd liveone
npm install
```

2. **Set up environment variables**

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# Clerk Authentication (Required)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/dashboard
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/setup

# Database (Required)
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-auth-token

# Optional: Keep empty in development
DATABASE_URL=file:./dev.db

# Upstash Redis Cache via Vercel KV (Optional but recommended)
KV_REST_API_URL=https://your-kv-instance.kv.vercel-storage.com
KV_REST_API_TOKEN=your-token-here

# Admin Users (comma-separated Clerk user IDs)
ADMIN_USER_IDS=user_xxx,user_yyy
```

3. **Initialize the database**

```bash
npm run db:push
```

4. **Start development server**

```bash
npm run dev
```

Visit [http://localhost:3000](http://localhost:3000)

## 🌐 Production Deployment

### Deploy to Vercel

1. **Push to GitHub**

```bash
git push origin main
```

2. **Import to Vercel**

- Go to [vercel.com](https://vercel.com)
- Import your GitHub repository
- Configure environment variables (same as `.env.local`)

3. **Set up Upstash Redis (via Vercel KV)** (recommended)

- Create KV database in Vercel dashboard (uses Upstash Redis)
- Copy `KV_REST_API_URL` and `KV_REST_API_TOKEN` to environment variables
- After first deployment, build the subscription registry:
  ```bash
  curl -X POST https://your-app.vercel.app/api/admin/kv/build-registry \
    -H "Authorization: Bearer <your-token>"
  ```

4. **Set up Cron Jobs**

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/minutely",
      "schedule": "* * * * *"
    },
    {
      "path": "/api/cron/daily",
      "schedule": "5 0 * * *"
    }
  ]
}
```

5. **Configure Cron Secret**

```bash
vercel env add CRON_SECRET production
# Generate a secure random string
```

## 👤 User Setup

### For System Owners

After signing up, users are guided through a setup wizard to configure their first system:

1. **Choose system type** - Select your inverter brand or energy retailer
2. **Enter credentials** - Provide API access credentials (stored securely in Clerk)
3. **Configure system** - Set timezone, name, and optional alias
4. **Point discovery** - System automatically discovers available monitoring points
5. **Customize points** - Configure point names, types, and grouping (optional)

Additional systems can be added from the dashboard settings.

### For Administrators

Admins have access to:

- `/admin` - System overview dashboard
- `/admin/users` - User management
- `/admin/storage` - Database statistics
- `/admin/kv` - Cache management tools
- Test any system connection
- View all system data

## 🔧 Development

### Project Structure

```
liveone/
├── app/                    # Next.js app router pages
│   ├── api/               # API routes (see docs/architecture/api.md)
│   ├── admin/             # Admin pages
│   └── dashboard/         # User dashboards
├── components/            # React components
├── lib/                   # Core libraries
│   ├── db/               # Database schema & client (see docs/architecture/data-model.md)
│   ├── auth-utils.ts     # Authentication helpers
│   └── energy-formatting.ts # Unit formatting
├── docs/                  # Documentation (see docs/README.md for the index)
│   ├── architecture/     # Architecture documentation
│   │   ├── overview.md   # Orientation: stack, data path, glossary
│   │   ├── data-model.md # Data semantics & invariants
│   │   └── api.md        # API conventions & route inventory
│   └── ...
└── scripts/              # Utility scripts
```

### Documentation

- **[docs/README.md](docs/README.md)** - Documentation index (start here)
- **[docs/architecture/overview.md](docs/architecture/overview.md)** - Architecture orientation: stack, data path, vendors
- **[docs/architecture/data-model.md](docs/architecture/data-model.md)** - Data semantics & invariants (schema source of truth: `lib/db/planetscale/schema.ts`)
- **[docs/architecture/api.md](docs/architecture/api.md)** - API conventions and route inventory
- **[docs/architecture/points.md](docs/architecture/points.md)** - Comprehensive guide to the point-based monitoring system

### Key Commands

```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run lint         # Run ESLint
npm run type-check   # TypeScript checking
npm test             # Run unit tests
npm run test:all     # Run all tests (unit + integration)
npm run db:push      # Update database schema
npm run db:studio    # Open Drizzle Studio for database exploration
```

### Utility Tools

The project includes maintenance utilities in `/tools` and `/scripts`:

- **`scripts/utils/backup-prod-db.sh`** - Backup production database

  ```bash
  ./scripts/utils/backup-prod-db.sh
  ```

- **`tools/sync-prod-to-dev.js`** - Sync production data to development

  ```bash
  node tools/sync-prod-to-dev.js
  ```

- **`tools/read-vercel-build-log.ts`** - Fetch Vercel build logs

  ```bash
  npx tsx tools/read-vercel-build-log.ts
  ```

- **`scripts/utils/get-test-token.ts`** - Generate test session token
  ```bash
  npx tsx scripts/utils/get-test-token.ts
  ```

### Adding New Vendor Support

The point-based architecture makes adding new vendors straightforward:

1. **Create vendor client** in `lib/vendor-clients/`:

   ```typescript
   export class NewVendorClient {
     async authenticate(): Promise<boolean> { ... }
     async fetchCurrentData(): Promise<VendorDataPoint[]> { ... }
   }
   ```

2. **Register vendor adapter** - Map vendor data to points
3. **Add to polling service** - Register in cron job
4. **Update UI** - Add vendor option to setup wizard

No database schema changes required - all metrics are stored as generic points.

## 📈 Performance

- **Response times**: < 100ms for cached point values, < 1s for historical queries
- **Data freshness**: 1-minute polling for real-time systems, 30-minute for Amber pricing
- **Storage efficiency**: ~50-200 KB/day per system (depends on point count)
- **Global CDN**: Vercel edge network with automatic caching
- **Database**: Turso with edge replicas for low-latency global access
- **Cache**: Upstash Redis (via Vercel KV) for sub-10ms latest value retrieval

## 🔒 Security

- **Authentication**: Enterprise-grade via Clerk with multi-factor support
- **Credential storage**: Encrypted in Clerk user metadata (never in database)
- **API protection**: Bearer tokens for cron jobs, session-based for users
- **Data isolation**: Users only see their own systems (admins can view all)
- **HTTPS only**: Enforced in production
- **Rate limiting**: Built into Vercel infrastructure

## 🤝 Contributing

We welcome contributions! Areas of interest:

- **Additional vendor integrations** - SolarEdge, Huawei, GoodWe, etc.
- **Enhanced composite systems** - More aggregation functions and transformations
- **MQTT broker integration** - Real-time push updates from local inverters
- **Home Assistant addon** - Bidirectional integration
- **Mobile app** - React Native with offline support
- **Energy optimization** - Smart load scheduling algorithms
- **Machine learning** - Solar forecasting and anomaly detection
- **Export formats** - CSV, Excel, PDF reports
- **Webhook notifications** - Alert integrations (Slack, Discord, etc.)

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Built with:

- [Next.js](https://nextjs.org/) — React framework
- [Vercel](https://vercel.com/) — Hosting platform
- [Turso](https://turso.tech/) — Edge database
- [Clerk](https://clerk.dev/) — Authentication
- [Tailwind CSS](https://tailwindcss.com/) — Styling
- [Chart.js](https://www.chartjs.org/) — Charts
- [Drizzle ORM](https://orm.drizzle.team/) — Database ORM
- [Claude](https://claude.ai) — Development and documentation

---

## 📝 Notes

### Database Architecture

The project uses a flexible point-based architecture (`point_info`, `point_readings`, `point_readings_agg_5m`, `point_readings_agg_1d`) where all metrics are stored as generic "points" with flexible metadata. This enables:

- Support for any vendor with arbitrary metric sets
- Adding new metrics without schema changes
- Tracking multiple devices in a single system
- Creating composite virtual systems

See [docs/architecture/data-model.md](docs/architecture/data-model.md) for data semantics and invariants; the schema source of truth is `lib/db/planetscale/schema.ts`.
