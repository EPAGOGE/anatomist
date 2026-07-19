CREATE TABLE "project_code_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"architecture_id" uuid NOT NULL,
	"architecture_event_hash" varchar(64) NOT NULL,
	"destination_kind" varchar(32) NOT NULL,
	"destination_repo" varchar(255) NOT NULL,
	"destination_branch" varchar(255) NOT NULL,
	"destination_path" varchar(512) NOT NULL,
	"commit_sha" varchar(40) NOT NULL,
	"code_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"chain_event_hash" varchar(64) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_code_exports" ADD CONSTRAINT "project_code_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_code_exports_project_idx" ON "project_code_exports" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_code_exports_architecture_idx" ON "project_code_exports" USING btree ("architecture_id","created_at");
