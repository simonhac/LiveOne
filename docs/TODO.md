# LiveOne Development TODO List

## ✅ Completed Features

### Foundation
- ✅ Next.js 15 with TypeScript and App Router
- ✅ Tailwind CSS with dark theme
- ✅ ESLint and build configuration
- ✅ Git repository with CI/CD via Vercel

### Database
- ✅ Turso (distributed SQLite) configuration
- ✅ Drizzle ORM implementation
- ✅ Complete schema with:
  - ✅ Multi-user systems table
  - ✅ Readings with timezone support
  - ✅ 5-minute and daily aggregations
  - ✅ Polling status tracking
  - ✅ User-system relationships

### Authentication
- ✅ Clerk authentication integration
- ✅ Multi-user support with role-based access
- ✅ Admin role with special privileges
- ✅ Secure credential storage in Clerk metadata
- ✅ Protected routes via middleware

### Device Management
- ✅ Multi-system support
- ✅ System-specific dashboards (/dashboard/[systemId])
- ✅ Admin system management interface
- ✅ Test connection functionality
- ✅ System info display with tooltips

### Selectronic Integration
- ✅ Complete Select.Live API client
- ✅ Authentication and session management
- ✅ Data fetching and parsing
- ✅ Error handling and retry logic
- ✅ Timezone-aware data processing

### Data Collection
- ✅ Vercel Cron job for minutely polling
- ✅ Automatic 5-minute aggregation
- ✅ Daily aggregation with timezone support
- ✅ Data retention (no automatic cleanup yet)
- ✅ Polling status monitoring

### Dashboard & Visualization
- ✅ Real-time power display with PowerCard components
- ✅ Energy statistics table (today/yesterday/all-time)
- ✅ Interactive Chart.js time-series graphs
- ✅ Power/Energy toggle functionality
- ✅ Auto-refresh when data is stale
- ✅ Responsive mobile design
- ✅ Visual indicators for offline systems
- ✅ Fault code display

### Data Visualization
- ✅ OpenNEM-compatible history API
- ✅ 5-minute, 30-minute, and daily intervals
- ✅ Up to 13 months of historical data
- ✅ Interactive charts with zoom/pan
- ✅ Export capabilities (via API)

### Admin Features
- ✅ Admin dashboard at /admin
- ✅ System overview with health monitoring
- ✅ User management interface
- ✅ Storage statistics page
- ✅ Database sync capabilities (dev)
- ✅ Activity monitoring

### Energy Formatting
- ✅ Smart SI unit scaling (kW, MW, GW)
- ✅ Unified formatting utilities
- ✅ Comprehensive test suite
- ✅ Support for both W and Wh units

## 🚧 In Progress

### Performance Optimization
- [ ] Implement data retention policies
- [ ] Add automatic cleanup for old raw data
- [ ] Optimize database queries with better indexes

## 📋 Planned Features

### Enhanced Monitoring
- [ ] Email alerts for system failures
- [ ] Generator monitoring
- [ ] Battery health tracking
- [ ] Predictive maintenance suggestions

### Data Export & Integration
- [ ] CSV/Excel export functionality
- [ ] MQTT broker integration
- [ ] Home Assistant addon
- [ ] Grafana datasource plugin

### Mobile Experience
- [ ] Progressive Web App (PWA)
- [ ] Push notifications
- [ ] Native mobile app

### Advanced Analytics
- [ ] Solar production forecasting
- [ ] Weather integration

### Enterprise Features
- [ ] Multi-site fleet management
- [ ] API rate limiting tiers

## 🔧 Technical Debt

### Testing
- [ ] Unit tests for API routes
- [ ] Integration tests for data flow
- [ ] E2E tests with Playwright

### Documentation
- [ ] Deployment best practices

### Security
- [ ] Security audit
- [ ] Penetration testing
- [ ] OWASP compliance check
- [ ] Rate limiting implementation

## 🐛 Known Issues

- [ ] Database sync from prod to dev needs error handling
- [ ] Daylight savings is mostly ignored
- [ ] Chart performance degrades with >30 days of 5-minute data

## 💡 Future Ideas

### Smart Features
- Machine learning for consumption prediction
- Anomaly detection for equipment issues

### Integrations
- Fronius inverter support
- Enphase compatibility
- Weather service integration

### Community Features
- Public dashboard sharing
- Neighborhood comparisons
- Community solar tracking

## Notes

- Priority is stability and reliability over new features
- Focus on user experience and mobile responsiveness
- Keep documentation up-to-date with each release