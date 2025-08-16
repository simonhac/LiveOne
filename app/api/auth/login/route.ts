import { NextRequest, NextResponse } from 'next/server';
import { APP_USERS } from '@/config';

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    
    // Find user by email and password
    const user = Object.values(APP_USERS).find(
      u => u.email === email && u.password === password
    );
    
    if (!user) {
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      );
    }
    
    // Create response with user data
    const response = NextResponse.json({
      success: true,
      user: {
        email: user.email,
        displayName: user.displayName,
        role: user.role
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