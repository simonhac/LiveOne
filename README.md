# LiveOne

Real-time monitoring dashboard for Selectronic SP PRO inverters.

## Overview

LiveOne provides a modern web-based dashboard for monitoring Selectronic SP PRO inverters in real-time, with automatic data polling, historical storage, and live updates via Server-Sent Events (SSE).

### Current Features

- 📊 **Real-time Dashboard** - Live power flow visualization with automatic updates
- 📈 **24-Hour Chart** - Interactive time-series chart showing solar, load, and battery SOC trends
  - Chart.js with responsive design and custom styling
  - Daytime/nighttime shading (7am-10pm highlighted)
  - Automatic y-axis scaling with units on top labels only
  - Timezone-aware display with proper AEST/AEDT handling
  - Always displays full 24-hour window, even with partial data
- ☀️ **Dual Solar Tracking** - Monitors both remote (inverter) and local (DC shunt) solar generation
- 🔋 **Battery Monitoring** - Real-time SOC, power flow, charge/discharge tracking
- ⚡ **Energy Statistics** - Daily and all-time energy totals with 3-decimal precision kWh storage
- 🚨 **Fault Detection** - Automatic alerts when fault codes are detected
- 📈 **Energy Delta Logging** - Precise energy change tracking between polls (3 decimal places)
- ℹ️ **System Information** - Display of inverter model, serial, ratings, and configuration
- 🔐 **User Authentication** - Secure login system with session management
- 💾 **Data Persistence** - SQLite database with optimized schema (totals only, no daily values)
- 🔄 **Automatic Polling** - Fetches data every minute from select.live API
- 📡 **Live Updates** - Server-Sent Events (SSE) for real-time dashboard updates
- 🎚️ **Grid Toggle** - Automatic display of grid data when import/export detected
- 🎨 **Modern UI** - Clean, compact dark theme with responsive design
- 🌐 **OpenNEM API Format** - History endpoint returns data in OpenNEM v4 format

### Planned Features (Future Enhancements)

- 📡 **MQTT Integration** - Publish data to MQTT brokers for home automation
- 📊 **Historical Charts** - Graphs and trends for energy production/consumption
- 🌡️ **Weather Integration** - Correlate solar production with weather data
- 📱 **Mobile App** - Native mobile applications for iOS/Android
- 🔔 **Alert System** - Email/SMS notifications for faults and thresholds
- 🏠 **Multi-System Support** - Monitor multiple inverters from one dashboard
- 📤 **Data Export** - CSV/JSON export of historical data
- 🔌 **Home Assistant Integration** - Direct integration with Home Assistant
- ⚙️ **Inverter Control** - Remote control of inverter settings (where supported)

## Architecture

### Current Stack

- **Frontend**: Next.js 14 with App Router, React, TypeScript
- **Charting**: Chart.js with react-chartjs-2, chartjs-adapter-date-fns
- **Styling**: Tailwind CSS with custom dark theme (removed DaisyUI for better control)
- **Icons**: Lucide React for consistent, professional iconography
- **Database**: SQLite with Drizzle ORM (production-ready with Turso)
- **Real-time Updates**: Server-Sent Events (SSE)
- **Authentication**: Session-based with bcrypt password hashing
- **Data Collection**: Server-side polling manager with 1-minute intervals
- **API Integration**: Direct connection to select.live using node-fetch
- **Timezone Handling**: @internationalized/date for proper AEST/AEDT conversion
- **MCP Integration**: Context7 MCP server for enhanced AI assistance

### Planned MQTT Architecture

When MQTT support is added, the system will publish to topics like:

```
liveone/{user_id}/{system_id}/status        # online/offline
liveone/{user_id}/{system_id}/battery/soc   # State of charge (%)
liveone/{user_id}/{system_id}/battery/power # Battery power (W)
liveone/{user_id}/{system_id}/solar/power   # Total solar generation (W)
liveone/{user_id}/{system_id}/solar/remote  # Remote solar (W)
liveone/{user_id}/{system_id}/solar/local   # Local/shunt solar (W)
liveone/{user_id}/{system_id}/grid/power    # Grid import/export (W)
liveone/{user_id}/{system_id}/load/power    # Load consumption (W)
liveone/{user_id}/{system_id}/fault/code    # Current fault code
liveone/{user_id}/{system_id}/raw           # Complete JSON payload
```

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Selectronic SP PRO with select.live account
- (Optional) Vercel account for deployment

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

3. Create your secrets file:
```bash
cp USER_SECRETS.example.ts USER_SECRETS.ts
```

4. Edit `USER_SECRETS.ts` with your Selectronic credentials and create a user account

5. Initialize the database:
```bash
npx tsx scripts/init-db.ts
```

6. Start development server:
```bash
npm run dev
```

7. Access the dashboard at [http://localhost:3000](http://localhost:3000)

### Optional: MCP Integration

For enhanced AI assistance with Claude, install the Context7 MCP server:

```bash
claude mcp add --transport http context7 https://mcp.context7.com/mcp
```

Then restart Claude to activate the MCP server.

### Deployment to Vercel

1. Push to GitHub
2. Import project in Vercel
3. Configure environment variables (if using environment variables instead of USER_SECRETS.ts)
4. Deploy

## Configuration

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

### Polling Configuration

The system automatically polls the Selectronic API every minute when running. You can adjust the polling interval in `config.ts`:

```typescript
POLLING_CONFIG.defaultInterval: 60000  // milliseconds
```

Note: The Selectronic API has a "magic window" from minutes 48-52 of each hour where it may be unavailable.

## API Endpoints (Currently Implemented)

### Data & Status
- `GET /api/data` - Get latest inverter data
- `GET /api/status` - Get polling status
- `GET /api/sse/user` - Server-sent events for real-time updates
- `GET /api/history` - Historical data in OpenNEM v4 format
  - Query params: `interval` (1m/1d/1w/1M), `fields` (solar,load,battery,grid)
  - Returns timezone-aware timestamps in AEST/AEDT
  - Supports up to 7 days of minute-resolution data

### Admin
- `GET /api/admin/systems` - View all systems (admin page)
- `POST /api/polling/start` - Start polling (development)

## Development

### Project Structure

```
liveone/
├── app/                    # Next.js app router
│   ├── dashboard/         # Main dashboard UI
│   ├── admin/            # Admin interface
│   ├── api/              # API routes
│   │   ├── history/      # OpenNEM-format historical data
│   │   └── sse/          # Server-sent events
│   └── page.tsx          # Login page
├── components/            # React components
│   └── EnergyChart.tsx   # 24-hour Chart.js visualization
├── lib/                   # Core libraries
│   ├── selectronic-fetch-client.ts  # Selectronic API client
│   ├── server/polling-manager.ts    # Server-side polling
│   ├── db/               # Database (Drizzle ORM)
│   ├── format-opennem.ts # OpenNEM format utilities
│   └── session-manager.ts # Session handling
├── scripts/              # Utility scripts
│   ├── init-db.ts        # Database initialization
│   └── test-fetch.ts     # API testing
├── tests/                # Unit tests
│   └── format-date.test.ts # Timezone formatting tests
├── docs/                 # Documentation
└── config.ts             # Main configuration
```

### Testing

```bash
# Test Selectronic API connection
npx tsx scripts/test-fetch.ts

# Run unit tests
npm test
```

## Known Issues & Limitations

- **Magic Window**: The Selectronic API is unavailable during minutes 48-52 of each hour
- **Single System**: Currently supports monitoring one inverter system at a time
- **Read-Only**: No inverter control capabilities (monitoring only)
- **Energy Values**: API returns kWh despite field names containing "_wh_"

## Contributing

Contributions are welcome! Areas of interest:
- MQTT integration
- Historical charting
- Multi-system support
- Mobile app development
- Home Assistant integration

## License

MIT License

## Acknowledgments

- Inspired by the original SelectronicMQTT C# project
- Built with Next.js, TypeScript, and Tailwind CSS
- Real-time updates via Server-Sent Events (SSE)