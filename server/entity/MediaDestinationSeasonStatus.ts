import { MediaStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { MediaDestinationStatus } from './MediaDestinationStatus';

@Entity('media_destination_season')
@Unique('UQ_media_destination_season_number', [
  'destinationStatusId',
  'seasonNumber',
])
export class MediaDestinationSeasonStatus {
  @PrimaryGeneratedColumn({
    primaryKeyConstraintName: 'PK_media_destination_season',
  })
  public id: number;

  @Column({ type: 'int' })
  public destinationStatusId: number;

  @ManyToOne(() => MediaDestinationStatus, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'destinationStatusId',
    foreignKeyConstraintName: 'FK_media_destination_season_destination',
  })
  public destinationStatus: MediaDestinationStatus;

  @Column({ type: 'int' })
  public seasonNumber: number;

  @Column({ type: 'int', default: MediaStatus.UNKNOWN })
  public status: MediaStatus;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MediaDestinationSeasonStatus>) {
    Object.assign(this, init);
  }
}
