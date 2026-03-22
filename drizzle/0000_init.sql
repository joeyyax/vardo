CREATE TYPE "public"."app_status" AS ENUM('active', 'stopped', 'error', 'deploying');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'running', 'success', 'failed', 'pruned');--> statement-breakpoint
CREATE TYPE "public"."backup_target_type" AS ENUM('s3', 'r2', 'b2', 'ssh');--> statement-breakpoint
CREATE TYPE "public"."clone_strategy" AS ENUM('clone', 'clone_data', 'empty', 'skip');--> statement-breakpoint
CREATE TYPE "public"."cron_job_run_status" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cron_job_status" AS ENUM('success', 'failed', 'running');--> statement-breakpoint
CREATE TYPE "public"."cron_job_type" AS ENUM('command', 'url');--> statement-breakpoint
CREATE TYPE "public"."deploy_type" AS ENUM('compose', 'dockerfile', 'image', 'static', 'nixpacks');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('queued', 'running', 'success', 'failed', 'cancelled', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'webhook', 'api', 'rollback');--> statement-breakpoint
CREATE TYPE "public"."environment_type" AS ENUM('production', 'staging', 'preview');--> statement-breakpoint
CREATE TYPE "public"."group_environment_type" AS ENUM('staging', 'preview');--> statement-breakpoint
CREATE TYPE "public"."notification_channel_type" AS ENUM('email', 'webhook', 'slack');--> statement-breakpoint
CREATE TYPE "public"."source" AS ENUM('git', 'direct');--> statement-breakpoint
CREATE TYPE "public"."template_category" AS ENUM('database', 'cache', 'monitoring', 'web', 'tool', 'custom');--> statement-breakpoint
CREATE TYPE "public"."transfer_status" AS ENUM('pending', 'accepted', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"app_id" text,
	"user_id" text,
	"action" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_token" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_tag" (
	"app_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "app_tag_uniq" UNIQUE("app_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "app_transfer" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"source_org_id" text NOT NULL,
	"destination_org_id" text NOT NULL,
	"status" "transfer_status" DEFAULT 'pending' NOT NULL,
	"initiated_by" text,
	"responded_by" text,
	"frozen_refs" jsonb,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"responded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "app" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"source" "source" DEFAULT 'git' NOT NULL,
	"deploy_type" "deploy_type" DEFAULT 'compose' NOT NULL,
	"git_url" text,
	"git_branch" text DEFAULT 'main',
	"git_key_id" text,
	"image_name" text,
	"compose_content" text,
	"compose_file_path" text DEFAULT 'docker-compose.yml',
	"root_directory" text,
	"auto_traefik_labels" boolean DEFAULT false,
	"container_port" integer,
	"auto_deploy" boolean DEFAULT false,
	"persistent_volumes" jsonb,
	"exposed_ports" jsonb,
	"restart_policy" text DEFAULT 'unless-stopped',
	"connection_info" jsonb,
	"project_id" text,
	"clone_strategy" "clone_strategy" DEFAULT 'clone',
	"depends_on" jsonb,
	"sort_order" integer DEFAULT 0,
	"template_name" text,
	"template_version" text,
	"status" "app_status" DEFAULT 'stopped' NOT NULL,
	"needs_redeploy" boolean DEFAULT false,
	"cpu_limit" real,
	"memory_limit" integer,
	"disk_write_alert_threshold" bigint,
	"auto_rollback" boolean DEFAULT false,
	"rollback_grace_period" integer DEFAULT 60,
	"env_content" text,
	"parent_app_id" text,
	"compose_service" text,
	"container_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_org_name_uniq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "backup_job_app" (
	"backup_job_id" text NOT NULL,
	"app_id" text NOT NULL,
	CONSTRAINT "backup_job_app_uniq" UNIQUE("backup_job_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "backup_job" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"target_id" text NOT NULL,
	"name" text NOT NULL,
	"schedule" text DEFAULT '0 2 * * *' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"keep_all" boolean DEFAULT false,
	"keep_last" integer,
	"keep_hourly" integer,
	"keep_daily" integer,
	"keep_weekly" integer,
	"keep_monthly" integer,
	"keep_yearly" integer,
	"notify_on_success" boolean DEFAULT false,
	"notify_on_failure" boolean DEFAULT true,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_target" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"type" "backup_target_type" NOT NULL,
	"config" jsonb NOT NULL,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"app_id" text NOT NULL,
	"target_id" text NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"volume_name" text,
	"size_bytes" bigint,
	"storage_path" text,
	"log" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "cron_job_run" (
	"id" text PRIMARY KEY NOT NULL,
	"cron_job_id" text NOT NULL,
	"status" "cron_job_run_status" NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp,
	"output" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "cron_job" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "cron_job_type" DEFAULT 'command' NOT NULL,
	"schedule" text NOT NULL,
	"command" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp,
	"last_status" "cron_job_status",
	"last_log" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deploy_key" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"status" "deployment_status" DEFAULT 'queued' NOT NULL,
	"trigger" "deployment_trigger" NOT NULL,
	"git_sha" text,
	"git_message" text,
	"log" text,
	"duration_ms" integer,
	"environment_id" text,
	"group_environment_id" text,
	"triggered_by" text,
	"env_snapshot" text,
	"config_snapshot" jsonb,
	"rollback_from_id" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "domain_check" (
	"id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"reachable" boolean NOT NULL,
	"status_code" integer,
	"response_time_ms" integer,
	"error" text,
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"domain" text NOT NULL,
	"service_name" text,
	"port" integer,
	"middlewares" text,
	"cert_resolver" text DEFAULT 'le',
	"is_primary" boolean DEFAULT false,
	"ssl_enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "domain_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "env_var" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"environment_id" text,
	"is_secret" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "env_var_app_key_env_uniq" UNIQUE("app_id","key","environment_id")
);
--> statement-breakpoint
CREATE TABLE "environment" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "environment_type" DEFAULT 'production' NOT NULL,
	"domain" text,
	"git_branch" text,
	"is_default" boolean DEFAULT false,
	"cloned_from_id" text,
	"group_environment_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "env_app_name_uniq" UNIQUE("app_id","name")
);
--> statement-breakpoint
CREATE TABLE "github_app_installation" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"installation_id" integer NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"account_avatar_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gh_install_user_uniq" UNIQUE("user_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "group_environment" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "group_environment_type" DEFAULT 'staging' NOT NULL,
	"source_environment" text DEFAULT 'production',
	"pr_number" integer,
	"pr_url" text,
	"created_by" text,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "group_env_project_name_uniq" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_channel" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "notification_channel_type" NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_domain" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"is_default" boolean DEFAULT false,
	"enabled" boolean DEFAULT true NOT NULL,
	"verified" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_domain_uniq" UNIQUE("organization_id","domain")
);
--> statement-breakpoint
CREATE TABLE "org_env_var" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"description" text,
	"is_secret" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "org_env_var_org_key_uniq" UNIQUE("organization_id","key")
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"base_domain" text,
	"ssl_enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#6366f1',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_org_name_uniq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tag" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6366f1' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tag_org_name_uniq" UNIQUE("organization_id","name")
);
--> statement-breakpoint
CREATE TABLE "template" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"icon" text,
	"category" "template_category" DEFAULT 'custom' NOT NULL,
	"source" "source" DEFAULT 'direct' NOT NULL,
	"deploy_type" "deploy_type" DEFAULT 'image' NOT NULL,
	"image_name" text,
	"git_url" text,
	"git_branch" text,
	"compose_content" text,
	"root_directory" text,
	"default_port" integer,
	"default_env_vars" jsonb,
	"default_volumes" jsonb,
	"default_connection_info" jsonb,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "template_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"is_app_admin" boolean DEFAULT false,
	"two_factor_enabled" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "volume_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"max_size_bytes" bigint NOT NULL,
	"warn_at_percent" integer DEFAULT 80,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "volume_limit_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
CREATE TABLE "volume" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"mount_path" text NOT NULL,
	"persistent" boolean DEFAULT true NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"description" text,
	"max_size_bytes" bigint,
	"warn_at_percent" integer DEFAULT 80,
	"ignore_patterns" jsonb,
	"drift_count" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "volume_app_name_uniq" UNIQUE("app_id","name"),
	CONSTRAINT "volume_app_mount_uniq" UNIQUE("app_id","mount_path")
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_token" ADD CONSTRAINT "api_token_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tag" ADD CONSTRAINT "app_tag_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_tag" ADD CONSTRAINT "app_tag_tag_id_tag_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tag"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_transfer" ADD CONSTRAINT "app_transfer_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_transfer" ADD CONSTRAINT "app_transfer_source_org_id_organization_id_fk" FOREIGN KEY ("source_org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_transfer" ADD CONSTRAINT "app_transfer_destination_org_id_organization_id_fk" FOREIGN KEY ("destination_org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_transfer" ADD CONSTRAINT "app_transfer_initiated_by_user_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_transfer" ADD CONSTRAINT "app_transfer_responded_by_user_id_fk" FOREIGN KEY ("responded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_git_key_id_deploy_key_id_fk" FOREIGN KEY ("git_key_id") REFERENCES "public"."deploy_key"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app" ADD CONSTRAINT "app_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job_app" ADD CONSTRAINT "backup_job_app_backup_job_id_backup_job_id_fk" FOREIGN KEY ("backup_job_id") REFERENCES "public"."backup_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job_app" ADD CONSTRAINT "backup_job_app_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job" ADD CONSTRAINT "backup_job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_job" ADD CONSTRAINT "backup_job_target_id_backup_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_target"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_target" ADD CONSTRAINT "backup_target_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_job_id_backup_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."backup_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup" ADD CONSTRAINT "backup_target_id_backup_target_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."backup_target"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_job_run" ADD CONSTRAINT "cron_job_run_cron_job_id_cron_job_id_fk" FOREIGN KEY ("cron_job_id") REFERENCES "public"."cron_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_job" ADD CONSTRAINT "cron_job_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deploy_key" ADD CONSTRAINT "deploy_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_group_environment_id_group_environment_id_fk" FOREIGN KEY ("group_environment_id") REFERENCES "public"."group_environment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment" ADD CONSTRAINT "deployment_triggered_by_user_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_check" ADD CONSTRAINT "domain_check_domain_id_domain_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_var" ADD CONSTRAINT "env_var_environment_id_environment_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment" ADD CONSTRAINT "environment_group_environment_id_group_environment_id_fk" FOREIGN KEY ("group_environment_id") REFERENCES "public"."group_environment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_app_installation" ADD CONSTRAINT "github_app_installation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_environment" ADD CONSTRAINT "group_environment_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_environment" ADD CONSTRAINT "group_environment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_domain" ADD CONSTRAINT "org_domain_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_env_var" ADD CONSTRAINT "org_env_var_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tag" ADD CONSTRAINT "tag_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume_limit" ADD CONSTRAINT "volume_limit_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume" ADD CONSTRAINT "volume_app_id_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volume" ADD CONSTRAINT "volume_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_parent_app_id_idx" ON "app" USING btree ("parent_app_id");--> statement-breakpoint
CREATE INDEX "cron_job_run_job_id_idx" ON "cron_job_run" USING btree ("cron_job_id");--> statement-breakpoint
CREATE INDEX "notification_channel_org_idx" ON "notification_channel" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "volume_app_id_idx" ON "volume" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "volume_org_id_idx" ON "volume" USING btree ("organization_id");