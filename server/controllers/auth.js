const User = require('../models/User');
const crypto = require('crypto');
const { sendEmail, sendPasswordResetEmail, sendVerificationOTP } = require('../utils/email');

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    // Check if user with this email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Email already registered'
      });
    }

    // Create user with isEmailVerified set to false
    const user = await User.create({
      name,
      email,
      password,
      isEmailVerified: false
    });

    // Generate OTP for email verification
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
    
    // Set OTP and expiry (10 minutes)
    user.emailVerificationOTP = otp;
    user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;

    await user.save({ validateBeforeSave: false });

    // Send verification email
    try {
      await sendVerificationOTP({
        email: user.email,
        otp: otp,
        userName: user.name
      });
      
      // Return response with verification needed flag but without full account creation message
      sendTokenResponse(user, 201, res, true);
    } catch (err) {
      console.error('Error sending verification email:', err);
      
      // Reset verification fields if email sending fails
      user.emailVerificationOTP = undefined;
      user.emailVerificationExpire = undefined;
      await user.save({ validateBeforeSave: false });
      
      return res.status(500).json({
        success: false,
        error: 'Registration initiated but verification email could not be sent. Please try again or contact support.'
      });
    }
  } catch (err) {
    console.error('Registration error:', err);
    next(err);
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Validate email & password
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: 'Please provide an email and password',
      });
    }

    // Check for user
    const user = await User.findOne({ email }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    // Check if password matches
    const isMatch = await user.matchPassword(password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials',
      });
    }

    // Check if email is verified
    if (!user.isEmailVerified) {
      // Send new OTP for verification
      const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
      
      user.emailVerificationOTP = otp;
      user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;
      await user.save({ validateBeforeSave: false });
      
      try {
        await sendVerificationOTP({
          email: user.email,
          otp: otp,
          userName: user.name
        });
      } catch (err) {
        console.error('Error sending verification email:', err);
        // Continue even if email fails
      }
      
      return sendTokenResponse(user, 200, res, true);
    }

    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// @desc    Get current logged in user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Forgot password
// @route   POST /api/auth/forgotpassword
// @access  Public
exports.forgotPassword = async (req, res, next) => {
  try {
    const user = await User.findOne({ email: req.body.email });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'There is no user with that email',
      });
    }

    // Get reset token
    const resetToken = crypto.randomBytes(20).toString('hex');

    // Hash token and set to resetPasswordToken field
    user.resetPasswordToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');

    // Set expire
    user.resetPasswordExpire = Date.now() + 30 * 60 * 1000; // 30 minutes

    await user.save({ validateBeforeSave: false });

    // Create reset url - Use client-side URL instead of API URL
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

    try {
      // Send enhanced password reset email
      await sendPasswordResetEmail({
        email: user.email,
        resetUrl: resetUrl,
        userName: user.name
      });

      res.status(200).json({
        success: true,
        data: 'Email sent',
      });
    } catch (err) {
      console.error('Error sending password reset email:', err);
      user.resetPasswordToken = undefined;
      user.resetPasswordExpire = undefined;

      await user.save({ validateBeforeSave: false });

      return res.status(500).json({
        success: false,
        error: 'Email could not be sent',
      });
    }
  } catch (err) {
    next(err);
  }
};

// @desc    Reset password
// @route   PUT /api/auth/resetpassword/:resettoken
// @access  Public
exports.resetPassword = async (req, res, next) => {
  try {
    // Get hashed token
    const resetPasswordToken = crypto
      .createHash('sha256')
      .update(req.params.resettoken)
      .digest('hex');

    const user = await User.findOne({
      resetPasswordToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid token',
      });
    }

    // Set new password
    user.password = req.body.password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;
    await user.save();

    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// @desc    Google auth login/register
// @route   POST /api/auth/google
// @access  Public
exports.googleAuth = async (req, res, next) => {
  try {
    const { email, name, googleId } = req.body;

    if (!email || !name || !googleId) {
      return res.status(400).json({
        success: false,
        error: 'Please provide email, name, and googleId',
      });
    }

    // Check if user exists
    let user = await User.findOne({ email });

    if (user) {
      // If user exists but doesn't have googleId, update it
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save({ validateBeforeSave: false });
      }
    } else {
      // Create new user with Google credentials
      // Generate a random secure password
      const randomPassword = crypto.randomBytes(16).toString('hex');
      
      user = await User.create({
        name,
        email,
        googleId,
        password: randomPassword, // This will be hashed by the pre-save hook
        isEmailVerified: true // Auto-verify email for Google users
      });
    }

    // Send token response
    sendTokenResponse(user, 200, res);
  } catch (err) {
    next(err);
  }
};

// @desc    Verify email with OTP
// @route   POST /api/auth/verify-email
// @access  Public
exports.verifyEmail = async (req, res, next) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Please provide email and OTP',
      });
    }

    // Find user by email
    const user = await User.findOne({ 
      email, 
      emailVerificationOTP: otp,
      emailVerificationExpire: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired OTP',
      });
    }

    // Mark email as verified
    user.isEmailVerified = true;
    user.emailVerificationOTP = undefined;
    user.emailVerificationExpire = undefined;

    await user.save({ validateBeforeSave: false });

    // Send token response with account creation message
    res.status(200).json({
      success: true,
      message: 'Account created successfully! Email verified.',
      token: user.getSignedJwtToken(),
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
      }
    });
  } catch (err) {
    console.error('Email verification error:', err);
    next(err);
  }
};

// @desc    Send OTP for email verification
// @route   POST /api/auth/send-verification-otp
// @access  Public
exports.sendVerificationOTP = async (req, res, next) => {
  try {
    const { email } = req.body;

    console.log('Request to send verification OTP received for email:', email);
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Please provide an email',
      });
    }

    // Find user by email
    const user = await User.findOne({ email });

    if (!user) {
      console.log('User not found for email:', email);
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
    console.log('Generated OTP for user:', otp);
    
    // Set OTP and expiry (10 minutes)
    user.emailVerificationOTP = otp;
    user.emailVerificationExpire = Date.now() + 10 * 60 * 1000;

    await user.save({ validateBeforeSave: false });
    console.log('Saved OTP to user document');

    // Send OTP via email with enhanced template
    try {
      console.log('Attempting to send verification email...');
      await sendVerificationOTP({
        email: user.email,
        otp: otp,
        userName: user.name
      });
      console.log('Verification email sent successfully');

      res.status(200).json({
        success: true,
        data: 'Verification email sent',
      });
    } catch (err) {
      console.error('Error sending verification email:', err);
      console.error('Email provider details:', {
        service: process.env.EMAIL_SERVICE,
        username: process.env.EMAIL_USERNAME,
        hasPassword: !!process.env.EMAIL_PASSWORD
      });
      
      user.emailVerificationOTP = undefined;
      user.emailVerificationExpire = undefined;

      await user.save({ validateBeforeSave: false });

      return res.status(500).json({
        success: false,
        error: 'Email could not be sent. Please check server logs.',
      });
    }
  } catch (err) {
    console.error('General error in sendVerificationOTP:', err);
    next(err);
  }
};

// Helper function to get token from model, create cookie and send response
const sendTokenResponse = (user, statusCode, res, verificationNeeded = false) => {
  // Create token
  const token = user.getSignedJwtToken();

  res.status(statusCode).json({
    success: true,
    token,
    user: {
      id: user._id,
      name: user.name,
      email: user.email,
    },
    verificationNeeded,
  });
}; 