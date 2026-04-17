# Install Node.js v25.9.0 and npm v11.12.1

## Current Versions
- Node.js: v23.11.0
- npm: v11.0.0

## Target Versions (Mentor's Requirement)
- Node.js: v25.9.0
- npm: v11.12.1

## 🚀 Installation Methods

### Method 1: Direct Download (Easiest)

1. **Download Node.js v25.9.0:**
   - Go to: https://nodejs.org/en/download/
   - Or direct link: https://nodejs.org/dist/v25.9.0/
   - Download: `node-v25.9.0-x64.msi` (for Windows 64-bit)

2. **Run the installer:**
   - Double-click the downloaded `.msi` file
   - Follow the installation wizard
   - Check "Automatically install necessary tools"
   - Click "Install"

3. **Verify installation:**
   ```powershell
   node --version
   # Should show: v25.9.0
   
   npm --version
   # Should show: 10.x.x (comes with Node)
   ```

4. **Update npm to v11.12.1:**
   ```powershell
   npm install -g npm@11.12.1
   ```

5. **Verify npm version:**
   ```powershell
   npm --version
   # Should show: 11.12.1
   ```

### Method 2: Using nvm-windows (Recommended for Managing Multiple Versions)

1. **Install nvm-windows:**
   - Download from: https://github.com/coreybutler/nvm-windows/releases
   - Download: `nvm-setup.exe`
   - Run the installer

2. **Install Node.js v25.9.0:**
   ```powershell
   nvm install 25.9.0
   nvm use 25.9.0
   ```

3. **Verify Node.js:**
   ```powershell
   node --version
   # Should show: v25.9.0
   ```

4. **Update npm:**
   ```powershell
   npm install -g npm@11.12.1
   ```

5. **Verify npm:**
   ```powershell
   npm --version
   # Should show: 11.12.1
   ```

## 🔄 After Installation

1. **Close and reopen your terminal** (PowerShell)

2. **Verify versions:**
   ```powershell
   node --version
   npm --version
   ```

3. **Reinstall project dependencies:**
   ```powershell
   cd C:\Users\KARTIK\Desktop\AUTOEDIT
   npm install
   ```

4. **Restart the dev server:**
   ```powershell
   npm run dev
   ```

## ⚠️ Important Notes

- **Close all terminals** before installing
- **Restart your computer** if versions don't update
- **Reinstall dependencies** after changing Node.js versions
- **nvm-windows** allows you to switch between Node.js versions easily

## 🎯 Quick Commands After Installation

```powershell
# Check versions
node --version
npm --version

# Reinstall dependencies
npm install

# Start frontend
npm run dev

# Start backend (in backend folder)
cd backend
python main.py
```

## 📋 Troubleshooting

### If `node --version` still shows old version:
1. Close all terminals
2. Restart computer
3. Open new PowerShell
4. Check again

### If npm update fails:
```powershell
# Clear npm cache
npm cache clean --force

# Try updating again
npm install -g npm@11.12.1
```

### If project doesn't run after update:
```powershell
# Delete node_modules and reinstall
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
npm install
```

## ✅ Final Verification

After installation, you should see:
```powershell
PS C:\Users\KARTIK\Desktop\AUTOEDIT> node --version
v25.9.0

PS C:\Users\KARTIK\Desktop\AUTOEDIT> npm --version
11.12.1
```

Then you're all set! 🎉
