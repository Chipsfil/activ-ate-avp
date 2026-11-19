import { auth } from '../api.js';
import { homeFor } from '../ui.js';

const user = await auth.restore();
location.replace(homeFor(user));
