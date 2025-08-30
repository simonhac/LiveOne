# LiveOne — Universal Solar Monitoring Platform

A modern, multi-user solar monitoring platform that bridges inverter systems to a unified dashboard. Currently supports Selectronic SP PRO inverters with an extensible architecture for additional brands.

## 🌟 Key Features

### Multi-User & Multi-System Architecture
- 👥 **Unlimited users** - Each user can monitor their own systems
- 🏠 **Multiple systems per user** - Monitor multiple sites from one account
- 🔐 **Secure authentication** - Enterprise-grade auth via Clerk
- 🎯 **Role-based access** - Owner and viewer roles
- 🔗 **Extensible design** - Ready to aditional inverters

### Real-Time Monitoring
- ⚡ **Live power flow** - Solar, battery, load, and grid visualization
- 📊 **Interactive charts** - 5-minute, 30-minute, and daily resolutions
- 📈 **Historical data** - Automatic aggregation
- 🔄 **Auto-refresh** - Updates when data becomes stale
- ⚠️ **Fault detection** - Real-time alerts and status indicators

### Professional Dashboard
- 📱 **Fully responsive** - Optimized for mobile, tablet, and desktop
- 🎨 **Modern UI** - Clean design with dark theme
- 📊 **Energy statistics** - Today, yesterday, and all-time summaries
- 🔀 **Power/Energy toggle** - Switch between kW and kWh views

### Admin Capabilities
- 🛠️ **System management** - Monitor all systems
- 👤 **User administration** - View access
- 📊 **Storage analytics** - Database metrics
- 🔧 **Test connections** - Validate inverter service credentials

## 🚀 Live Demo

Visit [liveone.energy](https://liveone.energy) to see the platform in action.

## 🏗️ Architecture

### Tech Stack
- **Frontend**: Next.js 15 (App Router), TypeScript, Tailwind CSS
- **Backend**: Vercel Serverless Functions, Node.js
- **Database**: Turso (Distributed SQLite), Drizzle ORM
- **Authentication**: Clerk (Multi-user support)
- **Hosting**: Vercel (Global CDN)
- **Charts**: Chart.js with interactive features
- **Data Collection**: Vercel Cron jobs (1-minute intervals)

### Extensible Design
```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Select.Live │     │   Fronius    │     │  SolarEdge  │
│     API      │     │   Solar.web  │     │     API     │
└──────┬───────┘     └──────┬───────┘     └──────┬──────┘
       │                     │                     │
       └─────────────────────┼─────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Vendor Adapter  │
                    │    Interface     │
                    └────────┬─────────┘
                             │
                    ┌────────▼────────┐
                    │   LiveOne Core   │
                    │   (Next.js App)  │
                    └────────┬─────────┘
                             │
                    ┌────────▼────────┐
                    │  Turso Database  │
                    │  (Global SQLite)  │
                    └──────────────────┘
```

## 📦 Installation

### Prerequisites
- Node.js 18+ and npm
- Clerk account (free tier works)
- Turso database account (free tier available)
- Vercel account for deployment (free tier works)
- Inverter with cloud monitoring access

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

3. **Set up Cron Jobs**

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

4. **Configure Cron Secret**
```bash
vercel env add CRON_SECRET production
# Generate a secure random string
```

## 👤 User Setup

### For System Owners

(Not yet implemented)


### For Administrators

Admins have access to:
- `/admin` - System overview dashboard
- `/admin/users` - User management
- `/admin/storage` - Database statistics
- Test any system connection
- View all system data


## 🔧 Development

### Project Structure
```
liveone/
├── app/                    # Next.js app router pages
│   ├── api/               # API routes
│   ├── admin/             # Admin pages
│   └── dashboard/         # User dashboards
├── components/            # React components
├── lib/                   # Core libraries
│   ├── db/               # Database schema & client
│   ├── auth-utils.ts    # Authentication helpers
│   └── energy-formatting.ts # Unit formatting
├── docs/                  # Documentation
└── scripts/              # Utility scripts
```

### Key Commands
```bash
npm run dev          # Start development server
npm run build        # Build for production
npm run lint         # Run ESLint
npm run type-check   # TypeScript checking
npm test            # Run tests
npm run db:push     # Update database schema
npm run db:studio   # Open database GUI
```

### Adding New Inverter Support

1. Create adapter in `lib/adapters/`:
```typescript
export interface InverterAdapter {
  authenticate(): Promise<boolean>
  fetchCurrent(): Promise<InverterData>
  fetchHistory(start: Date, end: Date): Promise<InverterData[]>
}
```

2. Implement vendor-specific client
3. Register in the polling service
4. Update UI components if needed

## 📈 Performance

- **Response times**: < 100ms for cached data
- **Data freshness**: 1-minute polling intervals
- **Storage efficiency**: ~180 KB/day per system
- **Global CDN**: Vercel edge network
- **Database**: Turso with edge replicas

## 🔒 Security

- **Authentication**: Enterprise-grade via Clerk
- **Credential storage**: Encrypted in Clerk metadata
- **API protection**: Bearer tokens for cron jobs
- **Data isolation**: Users only see their systems
- **HTTPS only**: Enforced in production

## 🤝 Contributing

We welcome contributions! Areas of interest:

- Additional inverter support (Fronius, SolarEdge, Enphase)
- MQTT broker integration
- Home Assistant addon
- Mobile app (React Native)
- Energy optimization algorithms
- Machine learning predictions

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
