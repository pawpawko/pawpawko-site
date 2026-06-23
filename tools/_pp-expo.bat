@echo off
title Expo (mobile features)
cd /d "C:\Users\jessi\pawpawko-mobile-features"
if not exist node_modules npm install
npx expo start
