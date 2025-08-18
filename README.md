# LiveOne - Selectronic SP PRO Monitor

Real-time monitoring dashboard for Selectronic SP PRO inverters, deployed on Vercel with Turso database.

## Features

- 🔋 Real-time monitoring of solar, battery, and load power
- 📊 Interactive dashboard with automatic updates
- 📈 Historical data with time-series charts
- ⚡ Energy/Power toggle - switch between kWh and average W display
- 🔄 Automatic data polling every minute via Vercel Cron
- 💾 Turso cloud database (globally distributed SQLite)
- 🔐 Multi-level authentication (user and admin)
- 📱 Responsive design for mobile and desktop
- 🌅 Timezone-aware daily aggregation

## Live Demo

https://liveone.vercel.app

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Selectronic SP PRO inverter with Select.Live access
- Vercel account (free tier works)
- Turso account for database (free tier available)

### Local Development

1. Clone and install:
```bash
git clone https://github.com/simonhac/liveone.git
cd liveone
npm install
```

2. Set up credentials:
```bash
cp USER_SECRETS.example.ts USER_SECRETS.ts
# Edit USER_SECRETS.ts with your Select.Live credentials
```

3. Configure environment:
```env
# .env.local
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-auth-token
AUTH_PASSWORD=password
ADMIN_PASSWORD=admin  # Optional admin access
```

4. Initialize database:
```bash
npm run db:push
```

5. Start development:
```bash
npm run dev
```

## Deployment to Vercel

### Deploy
```bash
vercel --prod
```

### Required Environment Variables

```bash
# Select.Live credentials
vercel env add SELECTRONIC_EMAIL production
vercel env add SELECTRONIC_PASSWORD production
vercel env add SELECTRONIC_SYSTEM production

# Database
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production

# Authentication
vercel env add AUTH_PASSWORD production
vercel env add ADMIN_PASSWORD production  # Optional

# Cron security
vercel env add CRON_SECRET production
```

## Architecture

### Tech Stack
- **Frontend**: Next.js 15, TypeScript, Tailwind CSS
- **Backend**: Vercel Serverless Functions
- **Database**: Turso (distributed SQLite)
- **Polling**: Vercel Cron jobs
- **Charts**: Chart.js

### Data Flow
1. Cron job polls Select.Live every minute
2. Data stored in Turso with timezone handling
3. Dashboard fetches data via REST API
4. Auto-refresh when data is 70+ seconds old
5. Daily aggregation runs at midnight AEST

## API Overview

### Main Endpoints
- `POST /api/auth/login` - User authentication
- `GET /api/data` - Current and historical data
- `GET /api/history` - Time-series data for charts
- `GET /api/cron/minutely` - Minute polling (cron)
- `GET /api/cron/daily` - Daily aggregation (cron)

See [API Documentation](docs/API.md) for complete details.

## Dashboard Features

### Energy/Power Toggle
Click the "Energy" header to toggle between:
- Energy mode: Shows kWh values
- Power mode: Shows average W based on time period

### Auto-refresh
Dashboard automatically refreshes when:
- Data is 70+ seconds old
- Regular 30-second polling cycle

### Admin Panel
Access with admin credentials to:
- View all systems
- Monitor polling status
- Check system health

## Development

### Scripts
- `npm run dev` - Development server
- `npm run build` - Production build
- `npm run lint` - Linting
- `npm run db:push` - Update database schema
- `npm run db:studio` - Database GUI

### Testing Tools
```bash
# Check latest deployment logs
npx tsx scripts/read-vercel-build-log.ts

# Test API endpoints
curl https://your-deployment.vercel.app/api/data \
  -H "Cookie: auth-token=your-password"
```

## Database

### Schema
- `systems` - Inverter configurations
- `readings` - Raw time-series data
- `readings_agg_5m` - 5-minute aggregates
- `readings_agg_1d` - Daily aggregates
- `polling_status` - System health

### Data Retention
- Raw data: Kept indefinitely
- Aggregates: Pre-computed for performance
- Storage: ~150 bytes/minute per system

## Monitoring

### Vercel Dashboard
1. Check Functions tab for cron executions
2. Review build logs for deployment issues
3. Monitor database usage in Turso dashboard

### Common Issues
- **No data**: Check cron job logs and credentials
- **Auth issues**: Verify environment variables
- **Timezone**: System uses AEST for daily boundaries

## Contributing

Areas of interest:
- Home Assistant integration
- MQTT support
- Multi-system dashboard
- Enhanced charting options
- Mobile app

## License

MIT

## Acknowledgments

Built with Next.js, TypeScript, Tailwind CSS, and Chart.js. Deployed on Vercel with Turso database.