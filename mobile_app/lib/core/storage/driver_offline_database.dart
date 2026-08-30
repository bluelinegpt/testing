import 'dart:io';

import 'package:bluelinegpt_mobile/core/services/service_ports.dart';
import 'package:sqflite/sqflite.dart';

/// Owns the single on-device SQLite database backing Driver offline support
/// (Prompt 16) — a durable local cache of assigned Orders/History/Dashboard
/// plus the durable status-change sync queue/outbox. One physical file for
/// the whole app install; every row is scoped by (`company_id`,
/// `driver_account_id`) at the repository layer
/// (`DriverOfflineCacheRepository` / `DriverSyncQueueRepository` in
/// `lib/features/driver/`) — this class only owns the schema, the
/// connection, and the whole-database clear used on logout.
///
/// `sqflite` was chosen over `drift`/`isar`/`hive` because it is the
/// mature, most-precedented relational local-DB choice for Flutter, and this
/// data is inherently relational and queryable (scoped reads, ordered
/// per-Order queue processing, bounded per-Order history) — a plain
/// key-value store (`hive`) would make the scoping and ordering guarantees
/// this feature depends on much harder to enforce correctly in one place.
final class DriverOfflineDatabase implements OfflineStore {
  DriverOfflineDatabase({this.factoryOverride, this.pathOverride});

  /// Overridden in tests to point at `sqflite_common_ffi`'s desktop-capable
  /// factory instead of the real platform-channel one.
  final DatabaseFactory? factoryOverride;
  final String? pathOverride;
  Database? _database;

  static const _fileName = 'driver_offline.db';
  static const _schemaVersion = 2;

  Future<Database> get database async => _database ??= await _open();

  Future<Database> _open() async {
    final factory = factoryOverride ?? databaseFactory;
    final directory = await factory.getDatabasesPath();
    final path =
        pathOverride ?? '$directory${Platform.pathSeparator}$_fileName';
    return factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: _schemaVersion,
        onCreate: (db, version) async {
          await db.execute('''
            CREATE TABLE driver_orders_cache (
              order_id TEXT NOT NULL,
              company_id TEXT NOT NULL,
              driver_account_id TEXT NOT NULL,
              order_number TEXT NOT NULL,
              serial_number TEXT NOT NULL,
              psystem_serial TEXT,
              reference TEXT,
              order_date TEXT NOT NULL,
              customer_name TEXT NOT NULL,
              customer_mobile TEXT NOT NULL,
              emirate_name_en TEXT,
              emirate_name_ar TEXT,
              area_id TEXT NOT NULL,
              area_name TEXT NOT NULL,
              address TEXT NOT NULL,
              expected_cod TEXT NOT NULL,
              amount_collected TEXT NOT NULL,
              status TEXT NOT NULL,
              trader_name TEXT NOT NULL,
              notes TEXT,
              last_synced_at TEXT NOT NULL,
              PRIMARY KEY (order_id, company_id, driver_account_id)
            )
          ''');
          await db.execute('''
            CREATE TABLE driver_order_history_cache (
              order_id TEXT NOT NULL,
              company_id TEXT NOT NULL,
              driver_account_id TEXT NOT NULL,
              sort_index INTEGER NOT NULL,
              from_status TEXT,
              to_status TEXT NOT NULL,
              occurred_at TEXT NOT NULL
            )
          ''');
          await db.execute(
            'CREATE INDEX idx_driver_history_scope ON '
            'driver_order_history_cache (order_id, company_id, driver_account_id)',
          );
          await db.execute('''
            CREATE TABLE driver_sync_queue (
              local_action_id TEXT PRIMARY KEY,
              company_id TEXT NOT NULL,
              driver_account_id TEXT NOT NULL,
              order_id TEXT NOT NULL,
              target_status TEXT NOT NULL,
              reason TEXT,
              expected_status TEXT,
              sequence INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              retry_count INTEGER NOT NULL DEFAULT 0,
              state TEXT NOT NULL,
              next_eligible_at TEXT
            )
          ''');
          await db.execute(
            'CREATE INDEX idx_driver_queue_scope ON driver_sync_queue '
            '(company_id, driver_account_id, order_id, sequence)',
          );
          await db.execute('''
            CREATE TABLE driver_dashboard_cache (
              company_id TEXT NOT NULL,
              driver_account_id TEXT NOT NULL,
              active_total INTEGER NOT NULL,
              assigned_to_me INTEGER NOT NULL,
              delivered_today INTEGER NOT NULL,
              out_for_delivery INTEGER NOT NULL,
              return_pending INTEGER NOT NULL,
              last_synced_at TEXT NOT NULL,
              PRIMARY KEY (company_id, driver_account_id)
            )
          ''');
        },
        onUpgrade: (db, oldVersion, newVersion) async {
          if (oldVersion < 2) {
            await db.execute(
              'ALTER TABLE driver_orders_cache ADD COLUMN psystem_serial TEXT',
            );
          }
        },
      ),
    );
  }

  /// Best-effort, whole-database clear on logout (Prompt 16 §T). This is a
  /// single-active-session-per-device app, so clearing every row is equally
  /// correct as — and simpler and more defensive than — a scoped delete: it
  /// holds even against a hypothetical bug that ever wrote a row under the
  /// wrong scope. `userId`/`companyId` are accepted only to satisfy the
  /// shared `OfflineStore` contract used elsewhere in this codebase.
  @override
  Future<void> clearScope({
    required String userId,
    required String companyId,
  }) => clearAll();

  Future<void> clearAll() async {
    final db = await database;
    final batch = db.batch()
      ..delete('driver_orders_cache')
      ..delete('driver_order_history_cache')
      ..delete('driver_sync_queue')
      ..delete('driver_dashboard_cache');
    await batch.commit(noResult: true);
  }

  Future<void> close() async {
    final db = _database;
    _database = null;
    await db?.close();
  }
}
