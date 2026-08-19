use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use savvy_domain::{
    ClientWorkspace, ContextSourceKind, EntityId, IndexedSourceChunk, MeetingSession,
    NegotiationBrief, Recommendation, SourceReference, TranscriptTurn,
};
use std::collections::HashSet;
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("stored object could not be decoded: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("storage file operation failed: {0}")]
    Io(#[from] std::io::Error),
}

pub struct Storage {
    connection: Connection,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        let connection = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let storage = Self { connection };
        storage.migrate()?;
        Ok(storage)
    }

    pub fn in_memory() -> Result<Self, StorageError> {
        let connection = Connection::open_in_memory()?;
        let storage = Self { connection };
        storage.migrate()?;
        Ok(storage)
    }

    fn migrate(&self) -> Result<(), StorageError> {
        self.connection.execute_batch(
            "PRAGMA auto_vacuum = INCREMENTAL;
             PRAGMA foreign_keys = ON;
             PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS clients (
               id TEXT PRIMARY KEY NOT NULL,
               body TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS briefs (
               id TEXT PRIMARY KEY NOT NULL,
               client_id TEXT NOT NULL,
               version INTEGER NOT NULL,
               status TEXT NOT NULL,
               body TEXT NOT NULL,
               UNIQUE(client_id, version)
             );
             CREATE TABLE IF NOT EXISTS meeting_sessions (
               id TEXT PRIMARY KEY NOT NULL,
               client_id TEXT NOT NULL,
               started_at TEXT NOT NULL,
               state TEXT NOT NULL,
               body TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS transcript_turns (
               id TEXT PRIMARY KEY NOT NULL,
               session_id TEXT NOT NULL,
               start_ms INTEGER NOT NULL,
               body TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS recommendations (
               id TEXT PRIMARY KEY NOT NULL,
               session_id TEXT NOT NULL,
               created_at TEXT NOT NULL,
               body TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS source_chunks (
               id TEXT PRIMARY KEY NOT NULL,
               scope_kind TEXT NOT NULL,
               scope_id TEXT NOT NULL,
               document_id TEXT NOT NULL,
               content_hash TEXT NOT NULL,
               body TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS source_chunks_scope
               ON source_chunks(scope_kind, scope_id);
             CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
               chunk_id UNINDEXED,
               text,
               tokenize = 'unicode61 remove_diacritics 2'
             );",
        )?;
        Ok(())
    }

    pub fn save_client(&self, client: &ClientWorkspace) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO clients(id, body) VALUES (?1, ?2)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            params![client.id.to_string(), serde_json::to_string(client)?],
        )?;
        Ok(())
    }

    pub fn list_clients(&self) -> Result<Vec<ClientWorkspace>, StorageError> {
        let mut statement = self
            .connection
            .prepare("SELECT body FROM clients ORDER BY id")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn delete_client(&self, client_id: EntityId) -> Result<bool, StorageError> {
        let client_id = client_id.to_string();
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM source_chunks_fts WHERE chunk_id IN
             (SELECT id FROM source_chunks WHERE scope_kind = 'Client' AND scope_id = ?1)",
            [&client_id],
        )?;
        transaction.execute(
            "DELETE FROM source_chunks WHERE scope_kind = 'Client' AND scope_id = ?1",
            [&client_id],
        )?;
        transaction.execute(
            "DELETE FROM recommendations WHERE session_id IN
             (SELECT id FROM meeting_sessions WHERE client_id = ?1)",
            [&client_id],
        )?;
        transaction.execute(
            "DELETE FROM transcript_turns WHERE session_id IN
             (SELECT id FROM meeting_sessions WHERE client_id = ?1)",
            [&client_id],
        )?;
        transaction.execute(
            "DELETE FROM meeting_sessions WHERE client_id = ?1",
            [&client_id],
        )?;
        transaction.execute("DELETE FROM briefs WHERE client_id = ?1", [&client_id])?;
        let deleted = transaction.execute("DELETE FROM clients WHERE id = ?1", [&client_id])?;
        transaction.commit()?;
        Ok(deleted > 0)
    }

    pub fn save_brief(&self, brief: &NegotiationBrief) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO briefs(id, client_id, version, status, body)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, body = excluded.body",
            params![
                brief.id.to_string(),
                brief.client_id.map(|id| id.to_string()).unwrap_or_default(),
                brief.version,
                format!("{:?}", brief.status),
                serde_json::to_string(brief)?,
            ],
        )?;
        Ok(())
    }

    pub fn get_brief(&self, id: EntityId) -> Result<Option<NegotiationBrief>, StorageError> {
        let body = self
            .connection
            .query_row(
                "SELECT body FROM briefs WHERE id = ?1",
                [id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        body.map(|value| serde_json::from_str(&value).map_err(StorageError::from))
            .transpose()
    }

    /// Forgets every brief for a scope, so the scope reads as having no brief at all.
    ///
    /// All versions go, not just the newest: deleting only the latest would surface the
    /// previous version instead of leaving the scope empty. Markdown files on disk are
    /// left alone — a generated brief can live inside the user's own client folder, and
    /// removing a brief here must never delete their files.
    pub fn delete_briefs_for_client(
        &self,
        client_id: Option<EntityId>,
    ) -> Result<usize, StorageError> {
        let deleted = self.connection.execute(
            "DELETE FROM briefs WHERE client_id = ?1",
            [client_id.map(|id| id.to_string()).unwrap_or_default()],
        )?;
        Ok(deleted)
    }

    pub fn latest_brief_for_client(
        &self,
        client_id: Option<EntityId>,
    ) -> Result<Option<NegotiationBrief>, StorageError> {
        let body = self
            .connection
            .query_row(
                "SELECT body FROM briefs WHERE client_id = ?1 ORDER BY version DESC LIMIT 1",
                [client_id.map(|id| id.to_string()).unwrap_or_default()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        body.map(|value| serde_json::from_str(&value).map_err(StorageError::from))
            .transpose()
    }

    pub fn save_session(&self, session: &MeetingSession) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO meeting_sessions(id, client_id, started_at, state, body)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET state = excluded.state, body = excluded.body",
            params![
                session.id.to_string(),
                session
                    .client_id
                    .map(|id| id.to_string())
                    .unwrap_or_default(),
                session.started_at.to_rfc3339(),
                format!("{:?}", session.state),
                serde_json::to_string(session)?,
            ],
        )?;
        Ok(())
    }

    pub fn get_session(&self, id: EntityId) -> Result<Option<MeetingSession>, StorageError> {
        self.decode_optional("SELECT body FROM meeting_sessions WHERE id = ?1", id)
    }

    pub fn latest_active_session(&self) -> Result<Option<MeetingSession>, StorageError> {
        let body = self
            .connection
            .query_row(
                "SELECT body FROM meeting_sessions
                 WHERE state IN ('Preparing', 'Recording', 'Paused')
                 ORDER BY started_at DESC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        body.map(|value| serde_json::from_str(&value).map_err(StorageError::from))
            .transpose()
    }

    pub fn list_sessions(&self) -> Result<Vec<MeetingSession>, StorageError> {
        let mut statement = self
            .connection
            .prepare("SELECT body FROM meeting_sessions ORDER BY started_at DESC")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn delete_session(&self, session_id: EntityId) -> Result<bool, StorageError> {
        let session_id = session_id.to_string();
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM recommendations WHERE session_id = ?1",
            [&session_id],
        )?;
        transaction.execute(
            "DELETE FROM transcript_turns WHERE session_id = ?1",
            [&session_id],
        )?;
        let deleted =
            transaction.execute("DELETE FROM meeting_sessions WHERE id = ?1", [&session_id])?;
        transaction.commit()?;
        Ok(deleted > 0)
    }

    pub fn save_transcript_turn(&self, turn: &TranscriptTurn) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO transcript_turns(id, session_id, start_ms, body)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            params![
                turn.id.to_string(),
                turn.session_id.to_string(),
                turn.start_ms,
                serde_json::to_string(turn)?,
            ],
        )?;
        Ok(())
    }

    pub fn list_transcript_turns(
        &self,
        session_id: EntityId,
    ) -> Result<Vec<TranscriptTurn>, StorageError> {
        self.decode_many(
            "SELECT body FROM transcript_turns WHERE session_id = ?1 ORDER BY start_ms",
            session_id,
        )
    }

    pub fn save_recommendation(&self, recommendation: &Recommendation) -> Result<(), StorageError> {
        self.connection.execute(
            "INSERT INTO recommendations(id, session_id, created_at, body)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET body = excluded.body",
            params![
                recommendation.id.to_string(),
                recommendation.session_id.to_string(),
                recommendation.created_at.to_rfc3339(),
                serde_json::to_string(recommendation)?,
            ],
        )?;
        Ok(())
    }

    pub fn latest_recommendation(
        &self,
        session_id: EntityId,
    ) -> Result<Option<Recommendation>, StorageError> {
        let body = self
            .connection
            .query_row(
                "SELECT body FROM recommendations WHERE session_id = ?1
                 ORDER BY created_at DESC LIMIT 1",
                [session_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        body.map(|value| serde_json::from_str(&value).map_err(StorageError::from))
            .transpose()
    }

    pub fn list_recommendations(
        &self,
        session_id: EntityId,
    ) -> Result<Vec<Recommendation>, StorageError> {
        self.decode_many(
            "SELECT body FROM recommendations WHERE session_id = ?1 ORDER BY created_at",
            session_id,
        )
    }

    pub fn replace_source_scope(
        &mut self,
        kind: ContextSourceKind,
        scope_id: EntityId,
        chunks: &[IndexedSourceChunk],
    ) -> Result<(), StorageError> {
        let kind = format!("{kind:?}");
        let scope_id = scope_id.to_string();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM source_chunks_fts WHERE chunk_id IN
             (SELECT id FROM source_chunks WHERE scope_kind = ?1 AND scope_id = ?2)",
            params![kind, scope_id],
        )?;
        transaction.execute(
            "DELETE FROM source_chunks WHERE scope_kind = ?1 AND scope_id = ?2",
            params![kind, scope_id],
        )?;
        for chunk in chunks {
            let id = chunk.source.chunk_id.to_string();
            transaction.execute(
                "INSERT INTO source_chunks(id, scope_kind, scope_id, document_id, content_hash, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    id,
                    kind,
                    scope_id,
                    chunk.source.document_id.to_string(),
                    chunk.content_hash,
                    serde_json::to_string(&chunk.source)?,
                ],
            )?;
            transaction.execute(
                "INSERT INTO source_chunks_fts(chunk_id, text) VALUES (?1, ?2)",
                params![id, chunk.source.excerpt],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn source_scope_revision(
        &self,
        kind: ContextSourceKind,
        scope_id: EntityId,
    ) -> Result<String, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT id || ':' || content_hash FROM source_chunks
             WHERE scope_kind = ?1 AND scope_id = ?2 ORDER BY id",
        )?;
        let hashes = statement
            .query_map(params![format!("{kind:?}"), scope_id.to_string()], |row| {
                row.get::<_, String>(0)
            })?;
        Ok(hashes.collect::<Result<Vec<_>, _>>()?.join(""))
    }

    pub fn search_source_chunks(
        &self,
        scopes: &[(ContextSourceKind, EntityId)],
        query: &str,
        limit: usize,
    ) -> Result<Vec<SourceReference>, StorageError> {
        let query = fts_query(query);
        if query.is_empty() || scopes.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let scope_filter =
            std::iter::repeat_n("(c.scope_kind = ? AND c.scope_id = ?)", scopes.len())
                .collect::<Vec<_>>()
                .join(" OR ");
        let sql = format!(
            "SELECT c.body
             FROM source_chunks_fts
             JOIN source_chunks c ON c.id = source_chunks_fts.chunk_id
             WHERE source_chunks_fts MATCH ? AND ({scope_filter})
             ORDER BY bm25(source_chunks_fts) LIMIT ?"
        );
        let mut values = vec![Value::Text(query)];
        for (kind, scope_id) in scopes {
            values.push(Value::Text(format!("{kind:?}")));
            values.push(Value::Text(scope_id.to_string()));
        }
        values.push(Value::Integer((limit * 8) as i64));
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params_from_iter(values), |row| row.get::<_, String>(0))?;
        let mut documents = HashSet::new();
        let mut results = Vec::new();
        for row in rows {
            let source: SourceReference = serde_json::from_str(&row?)?;
            if documents.insert(source.document_id) {
                results.push(source);
            }
            if results.len() == limit {
                break;
            }
        }
        Ok(results)
    }

    pub fn source_references_for_scope(
        &self,
        kind: ContextSourceKind,
        scope_id: EntityId,
        limit: usize,
    ) -> Result<Vec<SourceReference>, StorageError> {
        let mut statement = self.connection.prepare(
            "SELECT body FROM source_chunks
             WHERE scope_kind = ?1 AND scope_id = ?2 ORDER BY id LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                format!("{kind:?}"),
                scope_id.to_string(),
                limit.min(i64::MAX as usize) as i64
            ],
            |row| row.get::<_, String>(0),
        )?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    pub fn compact(&self) -> Result<(), StorageError> {
        let auto_vacuum = self
            .connection
            .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u8>(0))?;
        if auto_vacuum == 2 {
            self.connection
                .execute_batch("PRAGMA optimize; PRAGMA incremental_vacuum")?;
        } else {
            self.connection
                .execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM; PRAGMA optimize")?;
        }
        Ok(())
    }

    fn decode_optional<T: serde::de::DeserializeOwned>(
        &self,
        sql: &str,
        id: EntityId,
    ) -> Result<Option<T>, StorageError> {
        let body = self
            .connection
            .query_row(sql, [id.to_string()], |row| row.get::<_, String>(0))
            .optional()?;
        body.map(|value| serde_json::from_str(&value).map_err(StorageError::from))
            .transpose()
    }

    fn decode_many<T: serde::de::DeserializeOwned>(
        &self,
        sql: &str,
        id: EntityId,
    ) -> Result<Vec<T>, StorageError> {
        let mut statement = self.connection.prepare(sql)?;
        let rows = statement.query_map([id.to_string()], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
}

fn fts_query(value: &str) -> String {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| word.chars().count() > 1)
        .take(16)
        .map(|word| format!("\"{}\"", word.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use uuid::Uuid;

    fn brief(client_id: Option<EntityId>, version: u32) -> NegotiationBrief {
        use chrono::Utc;
        use savvy_domain::BriefStatus;

        NegotiationBrief {
            id: uuid::Uuid::new_v4(),
            client_id,
            version,
            status: BriefStatus::Draft,
            title: "Brief".into(),
            objective: String::new(),
            response_language: "en".into(),
            our_position: String::new(),
            client_position: String::new(),
            priorities: vec![],
            agenda: vec![],
            desired_outcomes: vec![],
            questions_to_ask: vec![],
            facts_to_use: vec![],
            concessions: vec![],
            red_lines: vec![],
            prohibited_claims: vec![],
            unauthorized_commitments: vec![],
            risks: vec![],
            custom_instructions: String::new(),
            document_path: None,
            document_content: String::new(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn clients_round_trip_without_touching_source_folder() {
        let storage = Storage::in_memory().expect("storage");
        let folder = std::env::temp_dir().join(format!("savvy-client-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).expect("client folder");
        let client = ClientWorkspace::new("Acme", PathBuf::from(&folder));
        storage.save_client(&client).expect("save client");
        assert_eq!(
            storage.list_clients().expect("list clients"),
            vec![client.clone()]
        );
        assert!(storage.delete_client(client.id).expect("delete client"));
        assert!(storage.list_clients().expect("list clients").is_empty());
        assert!(folder.is_dir());
        std::fs::remove_dir(folder).expect("remove client folder");
    }

    #[test]
    fn standalone_briefs_version_and_survive_client_deletion() {
        let storage = Storage::in_memory().expect("storage");
        let client = ClientWorkspace::new("Acme", PathBuf::from("/tmp/acme"));
        storage.save_client(&client).expect("save client");
        storage.save_brief(&brief(None, 1)).expect("standalone v1");
        let latest = brief(None, 2);
        storage.save_brief(&latest).expect("standalone v2");
        storage
            .save_brief(&brief(Some(client.id), 1))
            .expect("client brief");

        assert_eq!(
            storage.latest_brief_for_client(None).expect("latest"),
            Some(latest)
        );
        storage.delete_client(client.id).expect("delete client");
        assert!(storage
            .latest_brief_for_client(None)
            .expect("standalone remains")
            .is_some());
        assert!(storage
            .latest_brief_for_client(Some(client.id))
            .expect("client brief removed")
            .is_none());
    }

    #[test]
    fn deleting_briefs_clears_every_version_for_that_scope_only() {
        let storage = Storage::in_memory().expect("storage");
        let client = ClientWorkspace::new("Acme", PathBuf::from("/tmp/acme"));
        storage.save_client(&client).expect("save client");
        storage.save_brief(&brief(None, 1)).expect("standalone v1");
        storage.save_brief(&brief(None, 2)).expect("standalone v2");
        storage
            .save_brief(&brief(Some(client.id), 1))
            .expect("client brief");

        assert_eq!(
            storage
                .delete_briefs_for_client(None)
                .expect("delete standalone briefs"),
            2
        );
        // Every version goes, so the scope reads as empty rather than falling back to v1.
        assert!(storage
            .latest_brief_for_client(None)
            .expect("standalone cleared")
            .is_none());
        // The client scope is untouched.
        assert!(storage
            .latest_brief_for_client(Some(client.id))
            .expect("client brief remains")
            .is_some());
    }

    #[test]
    fn legacy_uuid_client_brief_round_trips_as_optional_client() {
        let storage = Storage::in_memory().expect("storage");
        let client_id = uuid::Uuid::new_v4();
        let brief = brief(Some(client_id), 1);
        storage
            .save_brief(&brief)
            .expect("save legacy-shaped brief");
        assert_eq!(
            storage
                .get_brief(brief.id)
                .expect("load brief")
                .unwrap()
                .client_id,
            Some(client_id)
        );
    }

    #[test]
    fn a_stored_brief_can_be_edited_in_place() {
        let storage = Storage::in_memory().expect("storage");
        let stored = brief(None, 1);
        storage.save_brief(&stored).expect("save brief");

        let mut changed = stored.clone();
        changed.title = "Changed".into();
        storage.save_brief(&changed).expect("briefs are editable");
        assert_eq!(storage.get_brief(stored.id).unwrap(), Some(changed));
    }

    #[test]
    fn existing_database_enables_incremental_compaction_on_demand() {
        let path = std::env::temp_dir().join(format!("savvy-storage-{}.sqlite", Uuid::new_v4()));
        Connection::open(&path)
            .unwrap()
            .execute("CREATE TABLE legacy(value TEXT)", [])
            .unwrap();
        let storage = Storage::open(&path).expect("open legacy database");
        assert_eq!(
            storage
                .connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u8>(0))
                .unwrap(),
            0
        );

        storage.compact().expect("compact database");
        assert_eq!(
            storage
                .connection
                .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, u8>(0))
                .unwrap(),
            2
        );
        drop(storage);
        std::fs::remove_file(path).expect("remove database");
    }

    #[test]
    fn meeting_artifacts_round_trip_in_timeline_order() {
        use chrono::Utc;
        use savvy_domain::{MeetingState, SpeakerChannel};
        use uuid::Uuid;

        let storage = Storage::in_memory().expect("storage");
        let session = MeetingSession {
            id: Uuid::new_v4(),
            client_id: Some(Uuid::new_v4()),
            brief_id: Some(Uuid::new_v4()),
            state: MeetingState::Recording,
            started_at: Utc::now(),
            ended_at: None,
            audio_path: None,
            context_pack_hash: "context".into(),
            source_index_revision: "sources".into(),
        };
        let session_id = session.id;
        storage.save_session(&session).expect("save session");
        for start_ms in [2_000, 500] {
            storage
                .save_transcript_turn(&TranscriptTurn {
                    id: Uuid::new_v4(),
                    session_id,
                    channel: SpeakerChannel::Other,
                    text: format!("turn {start_ms}"),
                    language: "en".into(),
                    start_ms,
                    end_ms: start_ms + 100,
                    is_final: true,
                    confidence: 1.0,
                })
                .expect("save turn");
        }
        assert_eq!(
            storage.get_session(session_id).expect("session"),
            Some(session)
        );
        assert_eq!(storage.list_sessions().expect("sessions").len(), 1);
        let turns = storage
            .list_transcript_turns(session_id)
            .expect("list turns");
        assert_eq!(turns[0].start_ms, 500);
        storage
            .connection
            .execute(
                "INSERT INTO recommendations(id, session_id, created_at, body) VALUES (?1, ?2, ?3, '{}')",
                params![Uuid::new_v4().to_string(), session_id.to_string(), Utc::now().to_rfc3339()],
            )
            .expect("save recommendation row");

        assert!(storage.delete_session(session_id).expect("delete meeting"));
        assert!(storage.get_session(session_id).expect("session").is_none());
        assert!(storage
            .list_transcript_turns(session_id)
            .expect("list turns")
            .is_empty());
        let recommendation_count: u32 = storage
            .connection
            .query_row(
                "SELECT COUNT(*) FROM recommendations WHERE session_id = ?1",
                [session_id.to_string()],
                |row| row.get(0),
            )
            .expect("count recommendations");
        assert_eq!(recommendation_count, 0);
    }

    #[test]
    fn source_search_is_scoped_and_returns_canonical_locators() {
        use savvy_domain::{ContextSourceKind, IndexedSourceChunk, SourceLocator, SourceReference};

        let mut storage = Storage::in_memory().expect("storage");
        let client_id = Uuid::new_v4();
        let document_id = Uuid::new_v4();
        let chunk_id = Uuid::new_v4();
        let source = SourceReference {
            kind: ContextSourceKind::Client,
            document_id,
            chunk_id,
            relative_path: PathBuf::from("proposal.md"),
            locator: SourceLocator {
                heading: Some("Commercial terms".into()),
                ..SourceLocator::document("Proposal")
            },
            excerpt: "The pilot price is 40000 euros for three integrations.".into(),
        };
        storage
            .replace_source_scope(
                ContextSourceKind::Client,
                client_id,
                &[IndexedSourceChunk {
                    scope_id: client_id,
                    source: source.clone(),
                    content_hash: "hash".into(),
                }],
            )
            .expect("index source");
        assert!(storage
            .search_source_chunks(
                &[(ContextSourceKind::Client, Uuid::new_v4())],
                "pilot price",
                6,
            )
            .expect("wrong scope search")
            .is_empty());
        assert_eq!(
            storage
                .search_source_chunks(
                    &[(ContextSourceKind::Client, client_id)],
                    "pilot price 40000",
                    6,
                )
                .expect("search"),
            vec![source]
        );
    }
}
