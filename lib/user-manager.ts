import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { systems } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export interface User {
  id: string;
  username: string;
  systemNumber: string;
  role?: 'user' | 'admin';
}

/**
 * Get the current user from the request
 * In production, this would parse JWT tokens or session cookies
 * For MVP, returns hardcoded user based on auth token
 */
export async function getCurrentUser(request: NextRequest): Promise<User | null> {
  // Check authentication - try Bearer token first, then cookie
  let token: string | undefined;
  
  // Check for Bearer token
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  }
  
  // If no Bearer token, check for cookie
  if (!token) {
    const cookieToken = request.cookies.get('auth-token');
    if (cookieToken) {
      token = cookieToken.value;
    }
  }
  
  // If no token, return null
  if (!token) {
    return null;
  }
  
  // Validate token
  const validPassword = process.env.AUTH_PASSWORD;
  const adminPassword = process.env.ADMIN_PASSWORD;
  
  if (token === adminPassword) {
    // Admin user
    return {
      id: 'admin',
      username: 'admin',
      systemNumber: process.env.SELECTRONIC_SYSTEM || '1586',
      role: 'admin'
    };
  } else if (!validPassword || token === validPassword) {
    // Regular user (in production, would look up user from database)
    // For MVP, return simon user
    return {
      id: 'simon',
      username: 'simon',
      systemNumber: process.env.SELECTRONIC_SYSTEM || '1586',
      role: 'user'
    };
  }
  
  return null;
}

/**
 * Get system for a user
 */
export async function getUserSystem(user: User) {
  const [system] = await db.select()
    .from(systems)
    .where(eq(systems.systemNumber, user.systemNumber))
    .limit(1);
    
  return system;
}

/**
 * Validate that a user has access to a specific system
 */
export async function userHasSystemAccess(user: User, systemNumber: string): Promise<boolean> {
  // Admin has access to all systems
  if (user.role === 'admin') {
    return true;
  }
  
  // Regular users only have access to their assigned system
  return user.systemNumber === systemNumber;
}

/**
 * Get all systems for a user
 * Admin users get all systems, regular users get only their system
 */
export async function getUserSystems(user: User) {
  if (user.role === 'admin') {
    // Admin gets all systems
    return await db.select().from(systems);
  }
  
  // Regular user gets only their system
  return await db.select()
    .from(systems)
    .where(eq(systems.systemNumber, user.systemNumber));
}