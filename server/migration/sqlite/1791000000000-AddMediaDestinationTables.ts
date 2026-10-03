import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMediaDestinationTables1791000000000
  implements MigrationInterface
{
  name = 'AddMediaDestinationTables1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "media_destination" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "mediaId" integer NOT NULL, "serverId" integer NOT NULL, "status" integer NOT NULL DEFAULT (1), "externalServiceId" integer, "externalServiceSlug" varchar, "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_media_destination_media_server" UNIQUE ("mediaId", "serverId"), CONSTRAINT "FK_media_destination_media" FOREIGN KEY ("mediaId") REFERENCES "media" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_media_destination_server" ON "media_destination" ("serverId")`
    );
    await queryRunner.query(
      `CREATE TABLE "media_destination_season" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "destinationStatusId" integer NOT NULL, "seasonNumber" integer NOT NULL, "status" integer NOT NULL DEFAULT (1), "createdAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updatedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_media_destination_season_number" UNIQUE ("destinationStatusId", "seasonNumber"), CONSTRAINT "FK_media_destination_season_destination" FOREIGN KEY ("destinationStatusId") REFERENCES "media_destination" ("id") ON DELETE CASCADE ON UPDATE NO ACTION)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "media_destination_season"`);
    await queryRunner.query(`DROP INDEX "IDX_media_destination_server"`);
    await queryRunner.query(`DROP TABLE "media_destination"`);
  }
}
