import Database, { sql } from '/lib/interfaces/database.ts';
import { User, UserSession, VerificationCode } from '/lib/types.ts';
import { generateRandomCode } from '/lib/utils/misc.ts';

const db = new Database();

export async function isThereAnAdmin() {
  const user =
    (await db.query<User>(sql`SELECT * FROM "bewcloud_users" WHERE ("extra" ->> 'is_admin')::boolean IS TRUE LIMIT 1`))[
      0
    ];

  return Boolean(user);
}

export async function getUserByEmail(email: string) {
  const lowercaseEmail = email.toLowerCase().trim();

  const user = (await db.query<User>(sql`SELECT * FROM "bewcloud_users" WHERE "email" = $1 LIMIT 1`, [
    lowercaseEmail,
  ]))[0];

  return user;
}

export async function getUserById(id: string) {
  const user = (await db.query<User>(sql`SELECT * FROM "bewcloud_users" WHERE "id" = $1 LIMIT 1`, [
    id,
  ]))[0];

  return user;
}

export async function createUser(email: User['email'], hashedPassword: User['hashed_password']) {
  const trialDays = 30;
  const now = new Date();
  const trialEndDate = new Date(new Date().setUTCDate(new Date().getUTCDate() + trialDays));

  const subscription: User['subscription'] = {
    external: {},
    expires_at: trialEndDate.toISOString(),
    updated_at: now.toISOString(),
  };

  const extra: User['extra'] = { is_email_verified: false };

  // First signup will be an admin "forever"
  if (!(await isThereAnAdmin())) {
    extra.is_admin = true;
    subscription.expires_at = new Date('2100-12-31').toISOString();
  }

  const newUser = (await db.query<User>(
    sql`INSERT INTO "bewcloud_users" (
      "email",
      "subscription",
      "status",
      "hashed_password",
      "extra"
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [
      email,
      JSON.stringify(subscription),
      extra.is_admin ? 'active' : 'trial',
      hashedPassword,
      JSON.stringify(extra),
    ],
  ))[0];

  return newUser;
}

export async function updateUser(user: User) {
  await db.query(
    sql`UPDATE "bewcloud_users" SET
        "email" = $2,
        "subscription" = $3,
        "status" = $4,
        "hashed_password" = $5,
        "extra" = $6
      WHERE "id" = $1`,
    [
      user.id,
      user.email,
      JSON.stringify(user.subscription),
      user.status,
      user.hashed_password,
      JSON.stringify(user.extra),
    ],
  );
}

export async function deleteUser(userId: string) {
  await db.query(
    sql`DELETE FROM "bewcloud_user_sessions" WHERE "user_id" = $1`,
    [
      userId,
    ],
  );

  await db.query(
    sql`DELETE FROM "bewcloud_verification_codes" WHERE "user_id" = $1`,
    [
      userId,
    ],
  );

  await db.query(
    sql`DELETE FROM "bewcloud_news_feed_articles" WHERE "user_id" = $1`,
    [
      userId,
    ],
  );

  await db.query(
    sql`DELETE FROM "bewcloud_news_feeds" WHERE "user_id" = $1`,
    [
      userId,
    ],
  );

  await db.query(
    sql`DELETE FROM "bewcloud_users" WHERE "id" = $1`,
    [
      userId,
    ],
  );
}

export async function getSessionById(id: string) {
  const session = (await db.query<UserSession>(
    sql`SELECT * FROM "bewcloud_user_sessions" WHERE "id" = $1 AND "expires_at" > now() LIMIT 1`,
    [
      id,
    ],
  ))[0];

  return session;
}

export async function createUserSession(user: User, isShortLived = false) {
  const oneMonthFromToday = new Date(new Date().setUTCMonth(new Date().getUTCMonth() + 1));
  const oneWeekFromToday = new Date(new Date().setUTCDate(new Date().getUTCDate() + 7));

  const newSession: Omit<UserSession, 'id' | 'created_at'> = {
    user_id: user.id,
    expires_at: isShortLived ? oneWeekFromToday : oneMonthFromToday,
    last_seen_at: new Date(),
  };

  const newUserSessionResult = (await db.query<UserSession>(
    sql`INSERT INTO "bewcloud_user_sessions" (
      "user_id",
      "expires_at",
      "last_seen_at"
    ) VALUES ($1, $2, $3)
      RETURNING *`,
    [
      newSession.user_id,
      newSession.expires_at,
      newSession.last_seen_at,
    ],
  ))[0];

  return newUserSessionResult;
}

export async function updateSession(session: UserSession) {
  await db.query(
    sql`UPDATE "bewcloud_user_sessions" SET
        "expires_at" = $2,
        "last_seen_at" = $3
      WHERE "id" = $1`,
    [
      session.id,
      session.expires_at,
      session.last_seen_at,
    ],
  );
}

export async function deleteUserSession(sessionId: string) {
  await db.query(
    sql`DELETE FROM "bewcloud_user_sessions" WHERE "id" = $1`,
    [
      sessionId,
    ],
  );
}

export async function validateUserAndSession(userId: string, sessionId: string) {
  const user = await getUserById(userId);

  if (!user) {
    throw new Error('Not Found');
  }

  const session = await getSessionById(sessionId);

  if (!session || session.user_id !== user.id) {
    throw new Error('Not Found');
  }

  const oneMonthFromToday = new Date(new Date().setUTCMonth(new Date().getUTCMonth() + 1));

  session.last_seen_at = new Date();
  session.expires_at = oneMonthFromToday;

  await updateSession(session);

  return { user, session };
}

export async function createVerificationCode(
  user: User,
  verificationId: string,
  type: VerificationCode['verification']['type'],
) {
  const inThirtyMinutes = new Date(new Date().setUTCMinutes(new Date().getUTCMinutes() + 30));

  const code = generateRandomCode();

  const newVerificationCode: Omit<VerificationCode, 'id' | 'created_at'> = {
    user_id: user.id,
    code,
    expires_at: inThirtyMinutes,
    verification: {
      id: verificationId,
      type,
    },
  };

  await db.query(
    sql`INSERT INTO "bewcloud_verification_codes" (
      "user_id",
      "code",
      "expires_at",
      "verification"
    ) VALUES ($1, $2, $3, $4)
      RETURNING "id"`,
    [
      newVerificationCode.user_id,
      newVerificationCode.code,
      newVerificationCode.expires_at,
      JSON.stringify(newVerificationCode.verification),
    ],
  );

  return code;
}

export async function validateVerificationCode(
  user: User,
  verificationId: string,
  code: string,
  type: VerificationCode['verification']['type'],
) {
  const verificationCode = (await db.query<VerificationCode>(
    sql`SELECT * FROM "bewcloud_verification_codes"
      WHERE "user_id" = $1 AND
        "code" = $2 AND
        "verification" ->> 'type' = $3 AND
        "verification" ->> 'id' = $4 AND 
        "expires_at" > now()
      LIMIT 1`,
    [
      user.id,
      code,
      type,
      verificationId,
    ],
  ))[0];

  if (verificationCode) {
    await db.query(
      sql`DELETE FROM "bewcloud_verification_codes" WHERE "id" = $1`,
      [
        verificationCode.id,
      ],
    );
  } else {
    throw new Error('Not Found');
  }
}
