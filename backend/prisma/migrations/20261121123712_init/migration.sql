-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('pending', 'rejected', 'executing', 'completed', 'needs_attention');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('active', 'attention', 'done');

-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "user_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "can_initiate" BOOLEAN NOT NULL DEFAULT false,
    "can_approve" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("user_id","space_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expires_on" DATE NOT NULL,
    "price_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "renewal_requests" (
    "id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "status" "RequestStatus" NOT NULL DEFAULT 'pending',
    "created_by_id" TEXT NOT NULL,
    "decided_by_id" TEXT,
    "amount_minor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "old_expires_on" DATE NOT NULL,
    "new_expires_on" DATE NOT NULL,
    "provider_operation_id" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "renewal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_events" (
    "id" SERIAL NOT NULL,
    "request_id" TEXT NOT NULL,
    "actor_id" TEXT,
    "from_status" "RequestStatus",
    "to_status" "RequestStatus" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "request_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_jobs" (
    "request_id" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'active',
    "post_attempts" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dispatch_jobs_pkey" PRIMARY KEY ("request_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "resources_space_id_idx" ON "resources"("space_id");

-- CreateIndex
CREATE INDEX "renewal_requests_space_id_created_at_idx" ON "renewal_requests"("space_id", "created_at");

-- CreateIndex
CREATE INDEX "renewal_requests_resource_id_created_at_idx" ON "renewal_requests"("resource_id", "created_at");

-- CreateIndex
CREATE INDEX "request_events_request_id_id_idx" ON "request_events"("request_id", "id");

-- CreateIndex
CREATE INDEX "dispatch_jobs_state_next_run_at_idx" ON "dispatch_jobs"("state", "next_run_at");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "renewal_requests" ADD CONSTRAINT "renewal_requests_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "renewal_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_jobs" ADD CONSTRAINT "dispatch_jobs_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "renewal_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Добавлено вручную: Prisma не умеет описывать частичные индексы в schema.prisma.
-- У одного ресурса может быть не больше одной АКТИВНОЙ заявки
-- (на согласовании, выполняется, требует внимания). Завершённых и отклонённых — сколько угодно.
-- Правило держит сама база, поэтому параллельные запросы обойти его не могут.
CREATE UNIQUE INDEX "one_active_request_per_resource"
  ON "renewal_requests" ("resource_id")
  WHERE "status" IN ('pending', 'executing', 'needs_attention');

-- Простые проверки целостности на уровне базы.
ALTER TABLE "resources" ADD CONSTRAINT "resources_price_non_negative" CHECK ("price_minor" >= 0);
ALTER TABLE "renewal_requests" ADD CONSTRAINT "requests_amount_non_negative" CHECK ("amount_minor" >= 0);
ALTER TABLE "renewal_requests" ADD CONSTRAINT "requests_dates_ordered" CHECK ("new_expires_on" > "old_expires_on");
