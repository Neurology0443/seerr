import { MediaStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import Media from './Media';

@Entity('media_destination')
@Unique('UQ_media_destination_media_server', ['mediaId', 'serverId'])
export class MediaDestinationStatus {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_media_destination',
  })
  public id: number;

  @Column({ type: 'int' })
  public mediaId: number;

  @ManyToOne(() => Media, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'mediaId',
    foreignKeyConstraintName: 'FK_media_destination_media',
  })
  public media: Media;

  @Column({ type: 'int' })
  @Index('IDX_media_destination_server')
  public serverId: number;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  public status: MediaStatus;

  @Column({ type: 'int', nullable: true })
  public externalServiceId?: number | null;

  @Column({ type: 'varchar', nullable: true })
  public externalServiceSlug?: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MediaDestinationStatus>) {
    Object.assign(this, init);
  }
}
