CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`mode` text DEFAULT 'auto' NOT NULL,
	`total_rounds` integer DEFAULT 5 NOT NULL,
	`current_round` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'lobby' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `manual_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`configurator_id` integer NOT NULL,
	`location_name` text NOT NULL,
	`spy_hint` text NOT NULL,
	`groups_characters_json` text NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pairings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`requester_id` integer NOT NULL,
	`target_id` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requester_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `player_round_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`pairing_status` text DEFAULT 'unpaired' NOT NULL,
	`paired_with` text,
	`verdict_active` integer DEFAULT 0 NOT NULL,
	`round_score` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`username` text,
	`display_name` text NOT NULL,
	`photo_file_id` text,
	`photo_path` text,
	`total_score` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	`joined_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `round_roles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`player_id` integer NOT NULL,
	`role` text NOT NULL,
	`character_name` text NOT NULL,
	`assigned_group` integer,
	`group_type` text,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `rounds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`round_number` integer NOT NULL,
	`location_key` text NOT NULL,
	`location_name` text NOT NULL,
	`spy_hint` text NOT NULL,
	`spy_player_id` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`spy_guess` text,
	`spy_guess_approved` integer,
	`started_at` text DEFAULT (datetime('now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`spy_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `spy_guess_votes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`round_id` integer NOT NULL,
	`voter_player_id` integer NOT NULL,
	`vote` integer NOT NULL,
	`voted_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`round_id`) REFERENCES `rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voter_player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
