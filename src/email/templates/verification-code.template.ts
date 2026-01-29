export const getVerificationEmailTemplate = (code: string, expiryMinutes: number = 10): string => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Email Verification</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .container {
      background-color: #f9f9f9;
      border-radius: 10px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 32px;
      font-weight: bold;
      color: #4CAF50;
    }
    .code-container {
      background-color: #fff;
      border: 2px dashed #4CAF50;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
      margin: 30px 0;
    }
    .code {
      font-size: 36px;
      font-weight: bold;
      letter-spacing: 8px;
      color: #4CAF50;
      margin: 10px 0;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      font-size: 12px;
      color: #666;
    }
    .warning {
      background-color: #fff3cd;
      border-left: 4px solid #ffc107;
      padding: 12px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">OrbitX Dispatch</div>
      <h2>Email Verification</h2>
    </div>

    <p>Hello,</p>

    <p>Thank you for registering with OrbitX Dispatch! To complete your registration, please use the verification code below:</p>

    <div class="code-container">
      <p style="margin: 0; font-size: 14px; color: #666;">Your Verification Code</p>
      <div class="code">${code}</div>
      <p style="margin: 0; font-size: 12px; color: #999;">This code will expire in ${expiryMinutes} minutes</p>
    </div>

    <p>Enter this code in the mobile app to verify your email address and activate your account.</p>

    <div class="warning">
      <strong>Security Notice:</strong> If you didn't request this verification code, please ignore this email. Do not share this code with anyone.
    </div>

    <div class="footer">
      <p>This is an automated email. Please do not reply to this message.</p>
      <p>&copy; 2025 OrbitX Dispatch. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
};

export const getPasswordResetTemplate = (code: string, expiryMinutes: number = 10): string => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Password Reset</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 600px;
      margin: 0 auto;
      padding: 20px;
    }
    .container {
      background-color: #f9f9f9;
      border-radius: 10px;
      padding: 30px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      font-size: 32px;
      font-weight: bold;
      color: #4CAF50;
    }
    .code-container {
      background-color: #fff;
      border: 2px dashed #f44336;
      border-radius: 8px;
      padding: 20px;
      text-align: center;
      margin: 30px 0;
    }
    .code {
      font-size: 36px;
      font-weight: bold;
      letter-spacing: 8px;
      color: #f44336;
      margin: 10px 0;
    }
    .footer {
      text-align: center;
      margin-top: 30px;
      font-size: 12px;
      color: #666;
    }
    .warning {
      background-color: #ffebee;
      border-left: 4px solid #f44336;
      padding: 12px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">OrbitX Dispatch</div>
      <h2>Password Reset Request</h2>
    </div>

    <p>Hello,</p>

    <p>We received a request to reset your password. Use the code below to proceed:</p>

    <div class="code-container">
      <p style="margin: 0; font-size: 14px; color: #666;">Password Reset Code</p>
      <div class="code">${code}</div>
      <p style="margin: 0; font-size: 12px; color: #999;">This code will expire in ${expiryMinutes} minutes</p>
    </div>

    <p>Enter this code in the mobile app to reset your password.</p>

    <div class="warning">
      <strong>Security Alert:</strong> If you didn't request a password reset, please ignore this email and ensure your account is secure. Someone may have tried to access your account.
    </div>

    <div class="footer">
      <p>This is an automated email. Please do not reply to this message.</p>
      <p>&copy; 2025 OrbitX Dispatch. All rights reserved.</p>
    </div>
  </div>
</body>
</html>
  `;
};
