# LiveOne

Real-time monitoring dashboard for Selectronic SP PRO inverters.

## Overview

LiveOne polls Selectronic Live service and publishes inverter data to MQTT topics, enabling integration with home automation systems, data logging, and custom monitoring solutions.

### Key Features

- 🔐 **User Authentication** - Secure multi-user support with device ownership
- 📊 **Real-time Dashboard** - Monitor inverter status, power flow, and battery state
- 📡 **MQTT Publishing** - Standard MQTT topics for easy integration
- ⏱️ **Automatic Polling** - Configurable polling intervals (default 1 minute)
- 📈 **Data Visualization** - Power flow diagrams and historical charts
- 🔔 **Connection Monitoring** - Track device status and receive alerts
- 🔒 **Encrypted Credentials** - Secure storage of Selectronic login details

## Architecture

Built on Vercel's serverless platform for reliability and scalability:

- **Frontend**: Next.js 15 with App Router, React, TypeScript
- **Styling**: Tailwind CSS with custom components
- **Database**: 
  - Development: SQLite (zero-config, file-based)
  - Production: Turso (edge-hosted SQLite) or PostgreSQL (Neon/Supabase)
- **ORM**: Drizzle ORM (type-safe, performant)
- **Real-time Updates**: Server-Sent Events (SSE)
- **Authentication**: Session-based with secure credentials
- **Data Collection**: Background polling manager with 1-minute intervals
- **Data Storage**: Time-series database with dual timestamps (inverter time & received time)

## MQTT Topic Structure

```
liveone/{user_id}/{device_id}/status        # online/offline
liveone/{user_id}/{device_id}/battery/soc   # State of charge (%)
liveone/{user_id}/{device_id}/battery/voltage
liveone/{user_id}/{device_id}/battery/current
liveone/{user_id}/{device_id}/battery/power
liveone/{user_id}/{device_id}/solar/power   # Solar generation (W)
liveone/{user_id}/{device_id}/solar/voltage
liveone/{user_id}/{device_id}/solar/current
liveone/{user_id}/{device_id}/grid/power    # Grid import/export (W)
liveone/{user_id}/{device_id}/grid/voltage
liveone/{user_id}/{device_id}/grid/frequency
liveone/{user_id}/{device_id}/load/power    # Load consumption (W)
liveone/{user_id}/{device_id}/inverter/temperature
liveone/{user_id}/{device_id}/inverter/mode
liveone/{user_id}/{device_id}/raw           # Complete JSON payload
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Vercel account (free tier works for testing)
- MQTT broker (HiveMQ Cloud free tier recommended)
- Selectronic SP PRO with Live monitoring enabled

### Installation

1. Clone the repository:
```bash
git clone https://github.com/simonhac/LiveOne.git
cd liveone
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env.local
```

4. Configure your environment variables in `.env.local`

5. Run database migrations:
```bash
npm run db:migrate
```

6. Start development server:
```bash
npm run dev
```

### Deployment

1. Push to GitHub
2. Import project in Vercel
3. Configure environment variables in Vercel dashboard
4. Deploy

## Configuration

### Configuration

All configuration is managed through TypeScript files:

- `config.ts` - Main application configuration
- `USER_SECRETS.ts` - User credentials (gitignored)

Database configuration is environment-aware:
- Development: SQLite (automatic, zero-config)
- Production: Set `DATABASE_URL` environment variable for Turso/PostgreSQL

### Database

The application stores all inverter data in a time-series database:

- **Automatic Recording**: Data fetched every minute and stored with dual timestamps
- **Historical Data**: Complete history of power, battery, solar, and grid metrics
- **Energy Counters**: Daily and lifetime energy totals (Wh)
- **System Information**: SP PRO model, serial, ratings, solar/battery sizes
- **API Health Tracking**: Monitors polling success rate and API delays

#### Database Management

```bash
# Initialize database
npx tsx scripts/init-db.ts

# View database in browser
npm run db:studio

# Check recent readings
sqlite3 ./dev.db "SELECT * FROM readings ORDER BY id DESC LIMIT 10;"
```

#### Scaling Considerations

- **Free Tier (Turso)**: Supports ~500 systems with 7-day raw data retention
- **Paid Tier ($29/mo)**: Supports 1000+ systems with full data retention
- **Data Growth**: ~170 bytes per reading, 43K readings/month per system

### Polling Intervals

Configure in `vercel.json`:
```json
{
  "crons": [{
    "path": "/api/cron/poll-devices",
    "schedule": "* * * * *"  // Every minute (Pro plan)
  }]
}
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/logout` - User logout

### Devices
- `GET /api/devices` - List user's devices
- `POST /api/devices` - Add new device
- `PUT /api/devices/[id]` - Update device
- `DELETE /api/devices/[id]` - Remove device
- `GET /api/devices/[id]/status` - Get device status

### Data
- `GET /api/devices/[id]/data` - Get latest readings
- `GET /api/devices/[id]/history` - Get historical data

### Admin
- `GET /api/cron/poll-devices` - Trigger manual poll (protected)

## Development

### Project Structure

```
liveone/
├── app/                    # Next.js app router
│   ├── (auth)/            # Authentication pages
│   ├── dashboard/         # Main app UI
│   ├── api/              # API routes
│   └── layout.tsx        # Root layout
├── components/            # React components
│   ├── ui/               # shadcn/ui components
│   ├── dashboard/        # Dashboard components
│   └── charts/           # Data visualizations
├── lib/                   # Utilities
│   ├── selectronic/      # Selectronic API client
│   ├── mqtt/             # MQTT client
│   ├── db/               # Database utilities
│   └── auth/             # Auth helpers
├── prisma/               # Database schema
└── public/               # Static assets
```

### Testing

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# E2E tests
npm run test:e2e
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by the original SelectronicMQTT project
- Built with Next.js and Vercel
- UI components from shadcn/ui

## Support

- Create an issue on GitHub
- Email: support@liveone.app
- Documentation: https://docs.liveone.app