-- Login needs to find a user by email before any tenant context can exist
-- (see the note in src/services/auth.service.ts and migration 0007) — RLS
-- correctly hides every row from a query with no context, so this can never
-- work as a normal query against the users table.
--
-- Fix: a single, narrow SECURITY DEFINER function that returns only the five
-- columns login needs, for at most one row. It runs with its OWNER's
-- privileges, not the caller's — so it can see across tenants — while the
-- app's normal connection role (docauto_app locally/CI; whatever restricted
-- role DATABASE_URL uses in production) keeps its ordinary RLS-restricted
-- privileges for everything else. The bypass is scoped to this one function,
-- not to a connection or a broadly-privileged role.
--
-- REQUIRES a one-time privileged setup step, run once by an admin connection
-- (the CI "Create app role" step does this for CI; in Supabase this means
-- running the two statements below via the SQL editor, which connects as
-- the `postgres` role — Supabase's own docs confirm `postgres` has
-- bypassrls by default, which is exactly what's needed here):
--
--   CREATE ROLE docauto_login_bootstrap NOLOGIN BYPASSRLS;
--   GRANT docauto_login_bootstrap TO <the role your app's DATABASE_URL uses>;
--   GRANT CREATE ON SCHEMA public TO docauto_login_bootstrap;
--
-- The third grant is required too: reassigning ownership of an object to a
-- role (the ALTER FUNCTION ... OWNER TO below) requires that role to have
-- CREATE privilege on the containing schema, not just membership.
--
-- This is deliberately NOT done inside this migration: migrations run as the
-- app's own (intentionally non-privileged) role, which cannot grant an
-- attribute — BYPASSRLS — that it does not itself have. Role membership
-- (the GRANT above) lets the app role reassign ownership of the function
-- below to docauto_login_bootstrap; it does NOT give the app role BYPASSRLS
-- itself — attributes aren't inherited through membership, only privileges
-- are. If docauto_login_bootstrap doesn't exist when this migration runs,
-- the ALTER FUNCTION OWNER TO step below will fail loudly rather than
-- silently leaving the function un-elevated.

CREATE OR REPLACE FUNCTION find_user_for_login(p_email varchar)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  email varchar,
  password_hash varchar,
  role user_role
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.tenant_id, u.email, u.password_hash, u.role
  FROM users u
  WHERE u.email = p_email
  LIMIT 1;
$$;

ALTER FUNCTION find_user_for_login(varchar) OWNER TO docauto_login_bootstrap;

-- BYPASSRLS only skips row-level policies — it does NOT grant the underlying
-- table-level SELECT privilege Postgres's regular ACL system still requires.
-- docauto_app owns the users table, so it can grant this itself; no
-- privileged setup step needed for this part. Column-level and scoped to
-- exactly what the function returns, nothing else on the table.
GRANT SELECT (id, tenant_id, email, password_hash, role) ON users TO docauto_login_bootstrap;

-- Nobody gets to call this except the app's own connection role. Explicit
-- grant to CURRENT_USER rather than a hardcoded role name, since migrations
-- always run as whatever role the app itself connects as (DATABASE_URL) in
-- every environment (local, CI, production) — hardcoding "docauto_app" here
-- would silently fail to grant the right role anywhere but this local setup.
REVOKE ALL ON FUNCTION find_user_for_login(varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_user_for_login(varchar) TO CURRENT_USER;
