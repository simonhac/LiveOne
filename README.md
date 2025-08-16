# LiveOne - Selectronic SP PRO Monitor

Real-time monitoring dashboard for Selectronic SP PRO inverters, deployed on Vercel with Turso database.

## Features

- 🔋 Real-time monitoring of solar, battery, and load power
- 📊 Beautiful dashboard with live updates via SSE
- 📈 Historical data with 24-hour charts
- 🔄 Automatic data polling every minute via Vercel Cron
- 💾 Turso cloud database (globally distributed SQLite)
- 🌐 RESTful API with OpenNEM v4 format support
- 🔐 Cookie-based authentication
- 📱 Responsive design for mobile and desktop
- ⚡ Serverless architecture on Vercel
- 🌅 Daytime/nighttime shading on charts

## Live Demo

https://liveone.vercel.app

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- Selectronic SP PRO inverter with Select.Live access
- Vercel account (free tier works)
- Turso account for database (free tier available)

### Local Development

1. Clone the repository:
```bash
git clone https://github.com/simonhac/liveone.git
cd liveone
```

2. Install dependencies:
```bash
npm install
```

3. Set up credentials for local development:
```bash
cp USER_SECRETS.example.ts USER_SECRETS.ts
# Edit USER_SECRETS.ts with your Select.Live credentials
```

4. Set up Turso database:
```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Create database
turso db create liveone-prod

# Get database URL and auth token
turso db show liveone-prod --url
turso db tokens create liveone-prod
```

5. Create `.env.local`:
```env
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-auth-token
```

6. Push database schema:
```bash
npm run db:push
```

7. Start development server:
```bash
npm run dev
```

## Deployment to Vercel

### 1. Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel --prod
```

### 2. Set Environment Variables

```bash
# Required for polling Select.Live
vercel env add SELECTRONIC_EMAIL production
vercel env add SELECTRONIC_PASSWORD production
vercel env add SELECTRONIC_SYSTEM production

# Required for database
vercel env add TURSO_DATABASE_URL production
vercel env add TURSO_AUTH_TOKEN production

# Required for cron jobs
vercel env add CRON_SECRET production

# Optional: Dashboard authentication
vercel env add AUTH_PASSWORD production
```

### 3. Verify Deployment

- Check Functions tab in Vercel dashboard for cron execution
- Visit your deployment URL to access the dashboard
- Monitor database for new readings every minute

## Architecture

### Serverless Design

The application runs on Vercel's serverless platform:
- **Frontend**: Next.js 15 with App Router, TypeScript, Tailwind CSS
- **Backend**: Serverless API routes
- **Database**: Turso (distributed SQLite)
- **Polling**: Vercel Cron jobs (every minute)
- **Real-time**: Server-Sent Events (SSE)
- **Charts**: Chart.js with responsive design

### Data Flow

1. Vercel Cron triggers `/api/cron/poll-systems` every minute
2. Cron job fetches data from Select.Live API
3. Data is stored in Turso database with timestamps
4. Dashboard connects via SSE for real-time updates
5. Historical data served via `/api/history` endpoint

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login with email and password
- `POST /api/auth/logout` - Logout and clear session

### Data Access
- `GET /api/data-serverless` - Get latest inverter data
- `GET /api/history` - Get historical data with aggregation
- `GET /api/sse/user-serverless` - Server-sent events for real-time updates

### History API Parameters
- `interval` - Data interval (5m only supported)
- `last` - Relative time range (e.g., "24h", "7d", "30m")
- `startTime` - ISO 8601 start time
- `endTime` - ISO 8601 end time
- `fields` - Comma-separated fields to return

Example:
```bash
curl "https://liveone.vercel.app/api/history?interval=5m&last=24h&fields=solar,load,battery" \
  -H "Cookie: auth-token=your-password"
```

### Response Format (OpenNEM v4)
```json
{
  "data": [
    {
      "id": "liveone.simon.1586.solar.power",
      "type": "power",
      "units": "MW",
      "history": {
        "start": "2025-08-15T23:45:00+10:00",
        "interval": "5m",
        "data": [0.012, 0.015, null, 0.018, ...]
      }
    }
  ]
}
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `TURSO_DATABASE_URL` | Turso database URL | Yes |
| `TURSO_AUTH_TOKEN` | Turso authentication token | Yes |
| `SELECTRONIC_EMAIL` | Select.Live email | Yes (production) |
| `SELECTRONIC_PASSWORD` | Select.Live password | Yes (production) |
| `SELECTRONIC_SYSTEM` | System number | Yes (production) |
| `CRON_SECRET` | Secret for cron job authentication | Yes (production) |
| `AUTH_PASSWORD` | Password for dashboard access | Optional |

## Database

### Turso Setup

1. Create account at https://turso.tech
2. Create new database
3. Get credentials:
   ```bash
   turso db show your-db --url
   turso db tokens create your-db
   ```

### Schema

- `systems` - Registered inverter systems
- `readings` - Time-series power data
- `polling_status` - Polling health monitoring
- `hourly_aggregates` - Hourly data aggregation

### Data Retention

- Raw data: 30 days (configurable)
- Aggregated data: 1 year
- ~170 bytes per reading, ~7MB/month per system

## Development

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run db:push` - Push database schema
- `npm run db:studio` - Open Drizzle Studio
- `npm run lint` - Run ESLint
- `npm run type-check` - Check TypeScript types

### Project Structure

```
liveone/
├── app/                    # Next.js app directory
│   ├── api/               # API routes
│   │   ├── cron/         # Cron job endpoints
│   │   ├── auth/         # Authentication
│   │   └── sse/          # Real-time updates
│   ├── dashboard/         # Dashboard page
│   └── page.tsx          # Login page
├── components/            # React components
│   └── EnergyChart.tsx   # 24-hour chart
├── lib/                   # Utility libraries
│   ├── db/               # Database schema
│   └── server/           # Server utilities
├── config.ts             # Application config
├── vercel.json           # Vercel configuration
└── USER_SECRETS.ts       # Local dev credentials
```

## Monitoring

### Check Cron Job Status

1. Go to Vercel dashboard
2. Navigate to Functions tab
3. Look for `/api/cron/poll-systems` executions
4. Check logs for successful polling

### Database Status

```javascript
// Check latest data
const { createClient } = require('@libsql/client');
const client = createClient({
  url: 'your-turso-url',
  authToken: 'your-token'
});

const result = await client.execute(`
  SELECT COUNT(*) as count, 
         MAX(inverter_time) as latest
  FROM readings
`);
console.log(result.rows[0]);
```

## Troubleshooting

### No Data Appearing

1. **Check Vercel Functions logs** for cron execution
2. **Verify environment variables** are set correctly
3. **Check Turso database** for connectivity
4. **Verify Select.Live credentials** are correct

### Authentication Issues

1. Ensure `AUTH_PASSWORD` is set if using password protection
2. Clear browser cookies and try again
3. Check browser console for errors

### Cron Job Not Running

1. Verify `CRON_SECRET` is set
2. Check Vercel Functions tab for errors
3. Ensure `vercel.json` has correct cron configuration
4. Check for "magic window" (minutes 48-52 of each hour when Select.Live API may be unavailable)

## Security

- Passwords stored as HTTP-only cookies
- API endpoints require authentication
- Cron jobs protected by `CRON_SECRET`
- Database access via secure tokens
- HTTPS enforced in production

## Known Limitations

- **Magic Window**: Select.Live API unavailable during minutes 48-52 of each hour
- **Single System**: Currently supports one inverter per deployment
- **Read-Only**: No inverter control capabilities
- **5-minute intervals**: Historical data aggregated to 5-minute intervals only

## Contributing

Contributions are welcome! Areas of interest:
- MQTT integration for home automation
- Multi-system support
- Additional chart types and timeframes
- Mobile app development
- Home Assistant integration

## License

MIT

## Acknowledgments

- Inspired by the original SelectronicMQTT C# project
- Built with Next.js, TypeScript, and Tailwind CSS
- Charts powered by Chart.js
- Database by Turso (SQLite at the edge)
- Deployed on Vercel's serverless platform