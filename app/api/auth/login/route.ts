import { NextRequest, NextResponse } from 'next/server';
import { APP_USERS } from '@/config';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    
    // Debug logging
    console.log('[Auth] Login attempt for:', email);
    console.log('[Auth] AUTH_PASSWORD from env:', process.env.AUTH_PASSWORD ? 'set' : 'not set');
    console.log('[Auth] ADMIN_PASSWORD from env:', process.env.ADMIN_PASSWORD ? 'set' : 'not set');
    
    // Check if this is an admin user first
    const isAdmin = process.env.ADMIN_PASSWORD && 
                    password === process.env.ADMIN_PASSWORD;
    
    // Check if password is valid (either admin password or regular password)
    const validPassword = process.env.AUTH_PASSWORD;
    const isValidPassword = isAdmin || (validPassword && password === validPassword);
    
    console.log('[Auth] Is admin?', isAdmin);
    console.log('[Auth] Is valid password?', isValidPassword);
    
    if (!isValidPassword) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }
    
    // Create response with user data
    const response = NextResponse.json({
      success: true,
      user: {
        email: email,
        displayName: isAdmin ? 'Admin' : 'User',
        role: isAdmin ? 'admin' : 'user'
      }
    });
    
    // Set HTTP-only cookie with the password as token
    // In production, you'd want to use a proper session token
    response.cookies.set('auth-token', password, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/'
    });
    
    return response;
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}