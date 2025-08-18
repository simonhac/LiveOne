#!/bin/bash

# Script to get the build logs of the most recent deployment
# This uses the Vercel CLI to fetch and display build logs

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🔍 Fetching most recent deployment..."

# Get the most recent deployment URL
LATEST_DEPLOYMENT=$(vercel ls 2>/dev/null | grep -E "https://liveone-[a-z0-9]+-simonahacs" | head -1)

if [ -z "$LATEST_DEPLOYMENT" ]; then
    echo -e "${RED}❌ Error: Could not find any deployments${NC}"
    exit 1
fi

echo -e "${GREEN}📦 Latest deployment: ${LATEST_DEPLOYMENT}${NC}"

# Get deployment status
echo ""
echo "📊 Deployment Details:"
vercel inspect "$LATEST_DEPLOYMENT" 2>/dev/null | grep -E "name|status|created|url" | head -5

echo ""
echo "📝 Build Logs:"
echo "=" 
echo ""

# Get the build logs
vercel inspect "$LATEST_DEPLOYMENT" --logs 2>&1

# Check if the command succeeded
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Build logs retrieved successfully${NC}"
else
    echo ""
    echo -e "${YELLOW}⚠️  Note: Build logs may not be available for failed deployments${NC}"
    echo "Trying alternative method..."
    
    # Try to get deployment info even if logs aren't available
    echo ""
    echo "Deployment Information:"
    vercel inspect "$LATEST_DEPLOYMENT" 2>&1 | grep -v "Fetching deployment"
fi

# Show how to use this deployment URL for testing
echo ""
echo "💡 To test this deployment:"
echo "   curl ${LATEST_DEPLOYMENT}/api/cron/aggregate-daily -H 'Cookie: auth-token=password' -d '{}'"