#!/usr/bin/env npx tsx

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

async function main() {
  const startTime = Date.now();
  
  console.log(`${colors.cyan}${colors.bold}🤖 Vercel Build Monitor${colors.reset}`);
  console.log(`${colors.gray}Fetching most recent deployment...${colors.reset}\n`);
  
  try {
    // Get the list of deployments
    const { stdout: listOutput } = await execAsync('vercel ls');
    const lines = listOutput.split('\n').filter(line => line.trim());
    
    // Find the first deployment URL (skip header lines)
    let deploymentUrl = '';
    for (const line of lines) {
      // Look for lines that contain deployment URLs
      if (line.includes('.vercel.app') && !line.includes('Age')) {
        // Extract the URL from the line  
        const match = line.match(/([a-z0-9-]+\.vercel\.app)/);
        if (match) {
          deploymentUrl = match[1];
          break;
        }
      }
    }
    
    if (!deploymentUrl) {
      console.error(`${colors.red}❌ Error: Could not find any deployments${colors.reset}`);
      process.exit(1);
    }
    
    console.log(`${colors.green}📦 Latest deployment:${colors.reset} ${colors.bold}https://${deploymentUrl}${colors.reset}`);
    
    // Get deployment details
    console.log(`\n${colors.cyan}📊 Deployment Details:${colors.reset}`);
    
    try {
      const { stdout: inspectOutput } = await execAsync(`vercel inspect ${deploymentUrl}`);
      
      // Extract key details from inspect output
      const lines = inspectOutput.split('\n');
      for (const line of lines) {
        if (line.includes('name') || 
            line.includes('status') || 
            line.includes('created') || 
            line.includes('url') ||
            line.includes('id')) {
          // Color status lines appropriately
          if (line.includes('status')) {
            if (line.includes('Ready') || line.includes('✓')) {
              console.log(`${colors.green}${line}${colors.reset}`);
            } else if (line.includes('Error') || line.includes('Failed')) {
              console.log(`${colors.red}${line}${colors.reset}`);
            } else if (line.includes('Building')) {
              console.log(`${colors.yellow}${line}${colors.reset}`);
            } else {
              console.log(line);
            }
          } else {
            console.log(line);
          }
        }
      }
    } catch (error) {
      console.error(`${colors.red}Error getting deployment details${colors.reset}`);
    }
    
    console.log(`\n${colors.cyan}🤖 Build Logs:${colors.reset}`);
    console.log('═'.repeat(60));
    
    // Get the build logs
    try {
      const { stdout: logsOutput, stderr: logsError } = await execAsync(`vercel inspect ${deploymentUrl} --logs 2>&1`);
      
      // Process the logs
      const logLines = logsOutput.split('\n');
      let logStartTime: number | null = null;
      let skipNextLine = false;
      
      for (const line of logLines) {
        // Skip Vercel CLI header lines
        if (line.includes('Vercel CLI')) {
          skipNextLine = true; // Skip the next line too (usually "Fetching deployment...")
          continue;
        }
        if (skipNextLine) {
          skipNextLine = false;
          continue;
        }
        
        // Extract timestamp if present and calculate relative time
        const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/);
        if (timestampMatch) {
          const timestamp = new Date(timestampMatch[1]).getTime();
          if (!logStartTime) {
            logStartTime = timestamp;
          }
          const relativeTime = ((timestamp - logStartTime) / 1000).toFixed(3);
          
          // Color code different log types
          if (line.includes('Error') || line.includes('Failed') || line.includes('error')) {
            console.log(`${colors.red}[${relativeTime}s] ${line.substring(timestampMatch[1].length)}${colors.reset}`);
          } else if (line.includes('Warning') || line.includes('⚠')) {
            console.log(`${colors.yellow}[${relativeTime}s] ${line.substring(timestampMatch[1].length)}${colors.reset}`);
          } else if (line.includes('✓') || line.includes('Success') || line.includes('Completed')) {
            console.log(`${colors.green}[${relativeTime}s] ${line.substring(timestampMatch[1].length)}${colors.reset}`);
          } else if (line.includes('Building') || line.includes('Compiling') || line.includes('Creating')) {
            console.log(`${colors.blue}[${relativeTime}s] ${line.substring(timestampMatch[1].length)}${colors.reset}`);
          } else {
            console.log(`${colors.gray}[${relativeTime}s]${colors.reset} ${line.substring(timestampMatch[1].length)}`);
          }
        } else if (line.trim()) {
          // Non-timestamp lines
          if (line.includes('Error') || line.includes('Failed')) {
            console.log(`${colors.red}${line}${colors.reset}`);
          } else if (line.includes('Warning') || line.includes('⚠')) {
            console.log(`${colors.yellow}${line}${colors.reset}`);
          } else if (line.includes('✓') || line.includes('Success')) {
            console.log(`${colors.green}${line}${colors.reset}`);
          } else {
            console.log(line);
          }
        }
      }
      
      // Calculate total build time if we found timestamps
      if (logStartTime) {
        const lastTimestamp = logLines
          .map(line => line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/))
          .filter(match => match)
          .map(match => new Date(match![1]).getTime())
          .pop();
        
        if (lastTimestamp) {
          const totalBuildTime = ((lastTimestamp - logStartTime) / 1000).toFixed(1);
          console.log('═'.repeat(60));
          console.log(`\n${colors.cyan}🏗️  Total build time:${colors.reset} ${colors.bold}${totalBuildTime} seconds${colors.reset}`);
        }
      }
      
      console.log(`\n${colors.green}${colors.bold}🤖 ✅ Build logs retrieved successfully${colors.reset}`);
      
    } catch (error: any) {
      console.log('═'.repeat(60));
      console.error(`\n${colors.yellow}⚠️  Note: Build logs may not be available${colors.reset}`);
      
      if (error.stderr && error.stderr.includes('Build logs are not available')) {
        console.log(`${colors.gray}The deployment may still be building or logs have expired.${colors.reset}`);
      }
      
      // Try to show deployment info as fallback
      console.log(`\n${colors.cyan}Deployment Information:${colors.reset}`);
      try {
        const { stdout: fallbackOutput } = await execAsync(`vercel inspect ${deploymentUrl}`);
        const relevantLines = fallbackOutput.split('\n').filter(line => 
          !line.includes('Fetching deployment') && 
          !line.includes('Vercel CLI') &&
          line.trim()
        );
        relevantLines.forEach(line => console.log(line));
      } catch (fallbackError) {
        console.error(`${colors.red}Could not retrieve deployment information${colors.reset}`);
      }
    }
    
    // Show test command
    console.log(`\n${colors.cyan}💡 To test this deployment:${colors.reset}`);
    console.log(`   ${colors.gray}curl https://${deploymentUrl}/api/data -H 'Cookie: auth-token=password'${colors.reset}`);
    
    // Calculate script execution time
    const scriptTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${colors.gray}🤖 Script completed in ${scriptTime} seconds${colors.reset}`);
    
  } catch (error: any) {
    console.error(`${colors.red}${colors.bold}🤖 Script error:${colors.reset}`, error.message || error);
    process.exit(1);
  }
}

// Run the script
main();