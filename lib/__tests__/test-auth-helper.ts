/**
 * Helper for authenticating in integration tests using Clerk's Testing Tokens
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import { clerkClient } from '@clerk/nextjs/server';

// Load environment variables
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

/**
 * Create a Clerk Testing Token for integration tests
 * This uses Clerk's official testing token feature
 */
export async function getTestingToken(): Promise<string | null> {
  try {
    const clerk = await clerkClient();
    
    // Create a testing token for the instance
    // This token can be used to bypass bot detection in tests
    const testingToken = await clerk.testingTokens.createTestingToken();
    
    console.log('Created Clerk testing token for tests');
    return testingToken.token;
  } catch (error) {
    console.error('Error creating testing token:', error);
    return null;
  }
}

/**
 * Get or create a test session token for API testing
 * 
 * This creates a session JWT token using Clerk's testing approach
 */
export async function getTestSession(): Promise<string | null> {
  const testUserId = process.env.TEST_USER_ID || 'user_31xcrIbiSrjjTIKlXShEPilRow7';
  
  try {
    const clerk = await clerkClient();
    
    // First, create a testing token to bypass bot detection
    const testingToken = await clerk.testingTokens.createTestingToken();
    process.env.CLERK_TESTING_TOKEN = testingToken.token;
    
    // Get the user to verify they exist
    const user = await clerk.users.getUser(testUserId);
    if (!user) {
      console.error('Test user not found:', testUserId);
      return null;
    }
    
    // Get existing sessions for this user
    const sessions = await clerk.sessions.getSessionList({ userId: testUserId });
    
    if (!sessions.data || sessions.data.length === 0) {
      console.error('No existing sessions for test user. Please sign in with this user first.');
      return null;
    }
    
    // Use the first active session
    const sessionId = sessions.data[0].id;
    console.log('Using existing session for test user:', sessionId);
    
    // Get a session JWT token
    // This creates a JWT that's valid for 60 seconds by default
    const token = await clerk.sessions.getToken(sessionId);
    
    if (!token.jwt) {
      console.error('Failed to get JWT from session token');
      return null;
    }
    
    console.log('Created session JWT for testing');
    return token.jwt;
  } catch (error) {
    console.error('Error creating test session:', error);
    return null;
  }
}

/**
 * Make an authenticated request to an API endpoint
 */
export async function makeAuthenticatedRequest(
  url: string,
  sessionToken: string,
  options: RequestInit = {}
): Promise<Response> {
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Cookie': `__session=${sessionToken}`,
    },
  });
}