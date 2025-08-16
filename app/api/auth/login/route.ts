import { NextRequest, NextResponse } from 'next/server';
import { APP_USERS } from '@/config';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    
    // In production, we don't have APP_USERS, so just validate the password
    // This is a simplified auth for the dashboard
    const validPassword = process.env.AUTH_PASSWORD || password; // Accept any password if AUTH_PASSWORD not set
    
    if (password !== validPassword) {
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
        displayName: 'User',
        role: 'user'
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