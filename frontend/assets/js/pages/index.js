import { auth } from '../api.js';

const user = await auth.restore();
location.replace(!user ? 'signin.html' : user.onboarding_step === 'done' ? 'dashboard.html' : 'signup.html');
