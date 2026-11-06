CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  username citext UNIQUE NOT NULL,
  email citext UNIQUE NOT NULL, 
  password_hash text NOT NULL, 
  first_name text NOT NULL,
  last_name text NOT NULL, 
  gender text NOT NULL, 
  date_of_birth date NOT NULL,
  height_cm numeric(5,1) NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  onboarding_step text NOT NULL DEFAULT '2',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refresh_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL, 
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS body_weights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weight_kg numeric(5,2) NOT NULL CHECK (weight_kg BETWEEN 30 AND 300), 
  measured_on date NOT NULL
);
CREATE INDEX IF NOT EXISTS body_weights_user_date ON body_weights(user_id, measured_on DESC);
CREATE TABLE IF NOT EXISTS sports (
  id text PRIMARY KEY, name text NOT NULL, 
  category text, met numeric(5,2) NOT NULL DEFAULT 6,
  aliases text[] NOT NULL DEFAULT '{}', 
  popularity integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS user_goals (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, 
  goal text NOT NULL, position integer NOT NULL,
  PRIMARY KEY(user_id, goal)
);
CREATE TABLE IF NOT EXISTS user_sports (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, 
  sport_id text REFERENCES sports(id),
  name text NOT NULL, PRIMARY KEY(user_id, name)
);
CREATE TABLE IF NOT EXISTS activity_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  sport_id text REFERENCES sports(id), 
  sport_name text NOT NULL, 
  minutes_per_session integer NOT NULL,
  sessions_per_week integer NOT NULL
);
CREATE TABLE IF NOT EXISTS nutrition_goals (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, 
  nutrient text NOT NULL, amount numeric(8,2) NOT NULL,
  PRIMARY KEY(user_id, nutrient)
);
CREATE TABLE IF NOT EXISTS workouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  sport_id text REFERENCES sports(id), 
  sport_name text NOT NULL, title text, 
  performed_on date NOT NULL,
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 1 AND 600), 
  distance_km numeric(7,2),
  intensity text NOT NULL DEFAULT 'medium', 
  notes text, kcal integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'done', 
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workouts_user_date ON workouts(user_id, performed_on DESC);
CREATE TABLE IF NOT EXISTS meals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  eaten_on date NOT NULL, 
  meal_type text NOT NULL, description text NOT NULL, source text NOT NULL DEFAULT 'manual',
  kcal numeric(8,1) NOT NULL DEFAULT 0, 
  protein_g numeric(8,1) NOT NULL DEFAULT 0,
  carbs_g numeric(8,1) NOT NULL DEFAULT 0, 
  fat_g numeric(8,1) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meals_user_date ON meals(user_id, eaten_on);
CREATE TABLE IF NOT EXISTS daily_logs (
  user_id uuid REFERENCES users(id) ON DELETE CASCADE, 
  log_date date NOT NULL,
  sleep_hours numeric(4,1), 
  water_l numeric(4,1), PRIMARY KEY(user_id, log_date)
);
CREATE TABLE IF NOT EXISTS networks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  bucket text NOT NULL, criteria jsonb NOT NULL, 
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS network_members (
  network_id uuid REFERENCES networks(id) ON DELETE CASCADE, 
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(), 
  left_at timestamptz, PRIMARY KEY(network_id, user_id)
);
CREATE TABLE IF NOT EXISTS cheers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  from_user uuid REFERENCES users(id) ON DELETE CASCADE,
  to_user uuid REFERENCES users(id) ON DELETE CASCADE, 
  habit text NOT NULL, week_start date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), 
  UNIQUE(from_user, to_user, habit, week_start)
);
CREATE TABLE IF NOT EXISTS chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), 
  conversation_id uuid REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role text NOT NULL, content text NOT NULL, 
  created_at timestamptz NOT NULL DEFAULT now()
);
