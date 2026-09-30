-- The rekordbox 7.2 schema of the tables a Navidrome import writes, taken from a real master.db.

CREATE TABLE `agentRegistry` (`registry_id` VARCHAR(255) PRIMARY KEY, `id_1` VARCHAR(255) DEFAULT NULL, `id_2` VARCHAR(255) DEFAULT NULL, `int_1` BIGINT DEFAULT NULL, `int_2` BIGINT DEFAULT NULL, `str_1` VARCHAR(255) DEFAULT NULL, `str_2` VARCHAR(255) DEFAULT NULL, `date_1` DATETIME DEFAULT NULL, `date_2` DATETIME DEFAULT NULL, `text_1` TEXT DEFAULT NULL, `text_2` TEXT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `agent_registry_id_1_id_2` ON `agentRegistry` (`id_1`, `id_2`);

CREATE TABLE `djmdAlbum` (`ID` VARCHAR(255) PRIMARY KEY, `Name` VARCHAR(255) DEFAULT NULL, `AlbumArtistID` VARCHAR(255) DEFAULT NULL, `ImagePath` VARCHAR(255) DEFAULT NULL, `Compilation` INTEGER DEFAULT NULL, `SearchStr` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_album__name` ON `djmdAlbum` (`Name`);

CREATE INDEX `djmd_album__album_artist_i_d` ON `djmdAlbum` (`AlbumArtistID`);

CREATE INDEX `djmd_album__u_u_i_d` ON `djmdAlbum` (`UUID`);

CREATE INDEX `djmd_album_rb_data_status` ON `djmdAlbum` (`rb_data_status`);

CREATE INDEX `djmd_album_rb_local_data_status` ON `djmdAlbum` (`rb_local_data_status`);

CREATE INDEX `djmd_album_rb_local_deleted` ON `djmdAlbum` (`rb_local_deleted`);

CREATE INDEX `djmd_album_rb_local_usn__i_d` ON `djmdAlbum` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdArtist` (`ID` VARCHAR(255) PRIMARY KEY, `Name` VARCHAR(255) DEFAULT NULL, `SearchStr` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_artist__name` ON `djmdArtist` (`Name`);

CREATE INDEX `djmd_artist__u_u_i_d` ON `djmdArtist` (`UUID`);

CREATE INDEX `djmd_artist_rb_data_status` ON `djmdArtist` (`rb_data_status`);

CREATE INDEX `djmd_artist_rb_local_data_status` ON `djmdArtist` (`rb_local_data_status`);

CREATE INDEX `djmd_artist_rb_local_deleted` ON `djmdArtist` (`rb_local_deleted`);

CREATE INDEX `djmd_artist_rb_local_usn__i_d` ON `djmdArtist` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdContent` (`ID` VARCHAR(255) PRIMARY KEY, `FolderPath` VARCHAR(255) DEFAULT NULL, `FileNameL` VARCHAR(255) DEFAULT NULL, `FileNameS` VARCHAR(255) DEFAULT NULL, `Title` VARCHAR(255) DEFAULT NULL, `ArtistID` VARCHAR(255) DEFAULT NULL, `AlbumID` VARCHAR(255) DEFAULT NULL, `GenreID` VARCHAR(255) DEFAULT NULL, `BPM` INTEGER DEFAULT NULL, `Length` INTEGER DEFAULT NULL, `TrackNo` INTEGER DEFAULT NULL, `BitRate` INTEGER DEFAULT NULL, `BitDepth` INTEGER DEFAULT NULL, `Commnt` TEXT DEFAULT NULL, `FileType` INTEGER DEFAULT NULL, `Rating` INTEGER DEFAULT NULL, `ReleaseYear` INTEGER DEFAULT NULL, `RemixerID` VARCHAR(255) DEFAULT NULL, `LabelID` VARCHAR(255) DEFAULT NULL, `OrgArtistID` VARCHAR(255) DEFAULT NULL, `KeyID` VARCHAR(255) DEFAULT NULL, `StockDate` VARCHAR(255) DEFAULT NULL, `ColorID` VARCHAR(255) DEFAULT NULL, `DJPlayCount` INTEGER DEFAULT NULL, `ImagePath` VARCHAR(255) DEFAULT NULL, `MasterDBID` VARCHAR(255) DEFAULT NULL, `MasterSongID` VARCHAR(255) DEFAULT NULL, `AnalysisDataPath` VARCHAR(255) DEFAULT NULL, `SearchStr` VARCHAR(255) DEFAULT NULL, `FileSize` INTEGER DEFAULT NULL, `DiscNo` INTEGER DEFAULT NULL, `ComposerID` VARCHAR(255) DEFAULT NULL, `Subtitle` VARCHAR(255) DEFAULT NULL, `SampleRate` INTEGER DEFAULT NULL, `DisableQuantize` INTEGER DEFAULT NULL, `Analysed` INTEGER DEFAULT NULL, `ReleaseDate` VARCHAR(255) DEFAULT NULL, `DateCreated` VARCHAR(255) DEFAULT NULL, `ContentLink` INTEGER DEFAULT NULL, `Tag` VARCHAR(255) DEFAULT NULL, `ModifiedByRBM` VARCHAR(255) DEFAULT NULL, `HotCueAutoLoad` VARCHAR(255) DEFAULT NULL, `DeliveryControl` VARCHAR(255) DEFAULT NULL, `DeliveryComment` VARCHAR(255) DEFAULT NULL, `CueUpdated` VARCHAR(255) DEFAULT NULL, `AnalysisUpdated` VARCHAR(255) DEFAULT NULL, `TrackInfoUpdated` VARCHAR(255) DEFAULT NULL, `Lyricist` VARCHAR(255) DEFAULT NULL, `ISRC` VARCHAR(255) DEFAULT NULL, `SamplerTrackInfo` INTEGER DEFAULT NULL, `SamplerPlayOffset` INTEGER DEFAULT NULL, `SamplerGain` FLOAT DEFAULT NULL, `VideoAssociate` VARCHAR(255) DEFAULT NULL, `LyricStatus` INTEGER DEFAULT NULL, `ServiceID` INTEGER DEFAULT NULL, `OrgFolderPath` VARCHAR(255) DEFAULT NULL, `Reserved1` TEXT DEFAULT NULL, `Reserved2` TEXT DEFAULT NULL, `Reserved3` TEXT DEFAULT NULL, `Reserved4` TEXT DEFAULT NULL, `ExtInfo` TEXT DEFAULT NULL, `rb_file_id` VARCHAR(255) DEFAULT NULL, `DeviceID` VARCHAR(255) DEFAULT NULL, `rb_LocalFolderPath` VARCHAR(255) DEFAULT NULL, `SrcID` VARCHAR(255) DEFAULT NULL, `SrcTitle` VARCHAR(255) DEFAULT NULL, `SrcArtistName` VARCHAR(255) DEFAULT NULL, `SrcAlbumName` VARCHAR(255) DEFAULT NULL, `SrcLength` INTEGER DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_content__master_d_b_i_d__master_song_i_d` ON `djmdContent` (`MasterDBID`, `MasterSongID`);

CREATE INDEX `djmd_content__genre_i_d` ON `djmdContent` (`GenreID`);

CREATE INDEX `djmd_content__label_i_d` ON `djmdContent` (`LabelID`);

CREATE INDEX `djmd_content__artist_i_d` ON `djmdContent` (`ArtistID`);

CREATE INDEX `djmd_content__remixer_i_d` ON `djmdContent` (`RemixerID`);

CREATE INDEX `djmd_content__org_artist_i_d` ON `djmdContent` (`OrgArtistID`);

CREATE INDEX `djmd_content__composer_i_d` ON `djmdContent` (`ComposerID`);

CREATE INDEX `djmd_content__album_i_d` ON `djmdContent` (`AlbumID`);

CREATE INDEX `djmd_content__key_i_d` ON `djmdContent` (`KeyID`);

CREATE INDEX `djmd_content_rb_local_deleted__service_i_d` ON `djmdContent` (`rb_local_deleted`, `ServiceID`);

CREATE INDEX `djmd_content_rb_local_deleted__file_type` ON `djmdContent` (`rb_local_deleted`, `FileType`);

CREATE INDEX `djmd_content_rb_local_deleted__bit_rate` ON `djmdContent` (`rb_local_deleted`, `BitRate`);

CREATE INDEX `djmd_content_rb_local_deleted__bit_depth` ON `djmdContent` (`rb_local_deleted`, `BitDepth`);

CREATE INDEX `djmd_content__u_u_i_d` ON `djmdContent` (`UUID`);

CREATE INDEX `djmd_content_rb_data_status` ON `djmdContent` (`rb_data_status`);

CREATE INDEX `djmd_content_rb_local_data_status` ON `djmdContent` (`rb_local_data_status`);

CREATE INDEX `djmd_content_rb_local_deleted` ON `djmdContent` (`rb_local_deleted`);

CREATE INDEX `djmd_content_rb_local_usn__i_d` ON `djmdContent` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdDevice` (`ID` VARCHAR(255) PRIMARY KEY, `MasterDBID` VARCHAR(255) DEFAULT NULL, `Name` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_device__u_u_i_d` ON `djmdDevice` (`UUID`);

CREATE INDEX `djmd_device_rb_data_status` ON `djmdDevice` (`rb_data_status`);

CREATE INDEX `djmd_device_rb_local_data_status` ON `djmdDevice` (`rb_local_data_status`);

CREATE INDEX `djmd_device_rb_local_deleted` ON `djmdDevice` (`rb_local_deleted`);

CREATE INDEX `djmd_device_rb_local_usn__i_d` ON `djmdDevice` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdGenre` (`ID` VARCHAR(255) PRIMARY KEY, `Name` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_genre__name` ON `djmdGenre` (`Name`);

CREATE INDEX `djmd_genre__u_u_i_d` ON `djmdGenre` (`UUID`);

CREATE INDEX `djmd_genre_rb_data_status` ON `djmdGenre` (`rb_data_status`);

CREATE INDEX `djmd_genre_rb_local_data_status` ON `djmdGenre` (`rb_local_data_status`);

CREATE INDEX `djmd_genre_rb_local_deleted` ON `djmdGenre` (`rb_local_deleted`);

CREATE INDEX `djmd_genre_rb_local_usn__i_d` ON `djmdGenre` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdMenuItems` (`ID` VARCHAR(255) PRIMARY KEY, `Class` INTEGER DEFAULT NULL, `Name` VARCHAR(255) DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_menu_items__u_u_i_d` ON `djmdMenuItems` (`UUID`);

CREATE INDEX `djmd_menu_items_rb_data_status` ON `djmdMenuItems` (`rb_data_status`);

CREATE INDEX `djmd_menu_items_rb_local_data_status` ON `djmdMenuItems` (`rb_local_data_status`);

CREATE INDEX `djmd_menu_items_rb_local_deleted` ON `djmdMenuItems` (`rb_local_deleted`);

CREATE INDEX `djmd_menu_items_rb_local_usn__i_d` ON `djmdMenuItems` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdPlaylist` (`ID` VARCHAR(255) PRIMARY KEY, `Seq` INTEGER DEFAULT NULL, `Name` VARCHAR(255) DEFAULT NULL, `ImagePath` VARCHAR(255) DEFAULT NULL, `Attribute` INTEGER DEFAULT NULL, `ParentID` VARCHAR(255) DEFAULT NULL, `SmartList` TEXT DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_playlist__parent_i_d` ON `djmdPlaylist` (`ParentID`);

CREATE INDEX `djmd_playlist__seq` ON `djmdPlaylist` (`Seq`);

CREATE INDEX `djmd_playlist__name` ON `djmdPlaylist` (`Name`);

CREATE INDEX `djmd_playlist__attribute` ON `djmdPlaylist` (`Attribute`);

CREATE INDEX `djmd_playlist__u_u_i_d` ON `djmdPlaylist` (`UUID`);

CREATE INDEX `djmd_playlist_rb_data_status` ON `djmdPlaylist` (`rb_data_status`);

CREATE INDEX `djmd_playlist_rb_local_data_status` ON `djmdPlaylist` (`rb_local_data_status`);

CREATE INDEX `djmd_playlist_rb_local_deleted` ON `djmdPlaylist` (`rb_local_deleted`);

CREATE INDEX `djmd_playlist_rb_local_usn__i_d` ON `djmdPlaylist` (`rb_local_usn`, `ID`);

CREATE TABLE `djmdSongPlaylist` (`ID` VARCHAR(255) PRIMARY KEY, `PlaylistID` VARCHAR(255) DEFAULT NULL, `ContentID` VARCHAR(255) DEFAULT NULL, `TrackNo` INTEGER DEFAULT NULL, `UUID` VARCHAR(255) DEFAULT NULL, `rb_data_status` INTEGER DEFAULT 0, `rb_local_data_status` INTEGER DEFAULT 0, `rb_local_deleted` TINYINT(1) DEFAULT 0, `rb_local_synced` TINYINT(1) DEFAULT 0, `usn` BIGINT DEFAULT NULL, `rb_local_usn` BIGINT DEFAULT NULL, `created_at` DATETIME NOT NULL, `updated_at` DATETIME NOT NULL);

CREATE INDEX `djmd_song_playlist__playlist_i_d__i_d` ON `djmdSongPlaylist` (`PlaylistID`, `ID`);

CREATE INDEX `djmd_song_playlist__content_i_d_rb_local_deleted` ON `djmdSongPlaylist` (`ContentID`, `rb_local_deleted`);

CREATE INDEX `djmd_song_playlist__u_u_i_d` ON `djmdSongPlaylist` (`UUID`);

CREATE INDEX `djmd_song_playlist_rb_data_status` ON `djmdSongPlaylist` (`rb_data_status`);

CREATE INDEX `djmd_song_playlist_rb_local_data_status` ON `djmdSongPlaylist` (`rb_local_data_status`);

CREATE INDEX `djmd_song_playlist_rb_local_deleted` ON `djmdSongPlaylist` (`rb_local_deleted`);

CREATE INDEX `djmd_song_playlist_rb_local_usn__i_d` ON `djmdSongPlaylist` (`rb_local_usn`, `ID`);
