# LiveOne - Selectronic SP PRO Monitor

Real-time monitoring dashboard for Selectronic SP PRO inverters, deployed on Vercel with Turso database.

## Features

### Core Monitoring
- 🔋 Real-time monitoring of solar, battery, and load power
- 📊 Interactive dashboard with automatic updates
- 📈 Historical data with time-series charts (5-minute, 30-minute, and daily resolution)
- 📅 Support for up to 13 months of historical data with daily aggregation
- ⚡ Energy/Power toggle - switch between kWh and average W display
- 🔄 Automatic data polling every minute via Vercel Cron
- 🌅 Timezone-aware daily aggregation

### Multi-System Support
- 🏠 System-specific URLs (`/dashboard/[systemId]`)
- 👥 Multi-user support with Clerk authentication
- 🔧 Comprehensive admin dashboard for system management
- 📊 PowerCard components with visual status indicators
- ⚠️ Fault code warnings and system health monitoring
- 💡 System info tooltips with detailed specifications

### Technical
- 💾 Turso cloud database (globally distributed SQLite)
- 🔐 Multi-level authentication (user and admin via Clerk)
- 📱 Responsive design for mobile and desktop
- 🎨 Modern UI with Tailwind CSS and component-based architecture

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
# Clerk Authentication (for multi-user support)
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
vercel env add CLERK_SECRET_KEY production

# Database
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production

# Legacy Authentication (if not using Clerk)
vercel env add AUTH_PASSWORD production
vercel env add ADMIN_PASSWORD production  # Optional

# Cron security
vercel env add CRON_SECRET production
```

## Architecture

### Tech Stack
- **Frontend**: Next.js 15, TypeScript, Tailwind CSS, React Components
- **Backend**: Vercel Serverless Functions
- **Database**: Turso (distributed SQLite) with Drizzle ORM
- **Authentication**: Clerk (multi-user support)
- **Polling**: Vercel Cron jobs
- **Charts**: Chart.js
- **UI Components**: PowerCard, SystemInfoTooltip, DashboardClient

### Data Flow
1. Cron job polls Select.Live every minute for all registered systems
2. Data stored in Turso with timezone handling and user association
3. System-specific dashboards fetch data via REST API with authentication
4. Auto-refresh when data is 70+ seconds old
5. Daily aggregation runs at midnight AEST for all systems
6. Admin dashboard provides centralized monitoring and management

### Component Architecture
- **Server Components**: `/dashboard/[systemId]/page.tsx`, `/admin/page.tsx`
- **Client Components**: `DashboardClient.tsx`, `AdminDashboardClient.tsx`
- **UI Components**: `PowerCard.tsx`, `SystemInfoTooltip.tsx`
- **Authentication**: `middleware.ts` with Clerk integration
- **Database**: Drizzle ORM with schema in `/lib/db/schema.ts`

## API Overview

### Main Endpoints
- `POST /api/auth/login` - User authentication via Clerk
- `GET /api/data?systemId=[id]` - Current and historical data for specific system
- `GET /api/history?systemId=[id]` - Time-series data for charts
  - Supports 5-minute, 30-minute, and daily intervals
  - Up to 13 months of historical data for daily resolution
  - OpenNEM-compatible format
- `GET /api/admin/systems` - Admin system overview and management
- `GET /api/cron/minutely` - Minute polling (cron)
- `GET /api/cron/daily` - Daily aggregation (cron)

See [API Documentation](docs/API.md) for complete details.

## Dashboard Features

### System-Specific Dashboards
- **URL Structure**: `/dashboard/[systemId]` for individual system monitoring
- **Multi-System Support**: Each system has its own dedicated dashboard
- **Authenticated Access**: Clerk-based authentication with user-specific system access

### Dashboard Components
- **PowerCard Grid**: 2/3 chart + 1/3 power cards responsive layout
- **Energy Statistics Table**: Comprehensive daily/total energy breakdown
- **Visual Status Indicators**: Striped backgrounds for offline/stale systems
- **System Info Tooltips**: Detailed specifications (model, serial, ratings, sizes)
- **Fault Warnings**: Real-time fault code detection and display

### Interactive Features
- **Energy/Power Toggle**: Click the "Energy" header to switch between kWh and average W
- **Auto-refresh**: Automatic updates when data is 70+ seconds old
- **Responsive Design**: Optimized for desktop and mobile viewing
- **Real-time Charts**: Interactive time-series data visualization

### Admin Dashboard
Comprehensive system management at `/admin`:
- **System Overview**: View all registered systems and their status
- **Health Monitoring**: Polling status and error tracking
- **User Management**: Multi-user system access control
- **Authentication Logs**: Session tracking and login history

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

## Recent Major Updates

### v2.0 - Multi-System Architecture (Latest)
- **System-Specific URLs**: Individual dashboards at `/dashboard/[systemId]`
- **Clerk Authentication**: Full multi-user support with secure authentication
- **Admin Dashboard**: Comprehensive system management and monitoring
- **PowerCard Components**: Visual system status with offline indicators
- **Enhanced UI**: Restored original dashboard layout with modern components
- **Database Schema**: Extended support for multiple users and systems

## Contributing

Areas of interest:
- Home Assistant integration
- MQTT support
- Enhanced charting options
- Mobile app
- Additional inverter brand support

## License

MIT

## Acknowledgments

Built with Next.js, TypeScript, Tailwind CSS, and Chart.js. Deployed on Vercel with Turso database.