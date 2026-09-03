
-- NOTE: row-level security was disabled on all tables after this schema was
-- loaded. Supabase enables RLS automatically on new tables, and with no
-- policies defined that denies everything to app_user. It must be turned back
-- on with org_id policies as part of the multi-tenancy work — see
-- docs/going-multi-tenant.md, Step 3.-- Baseline: the schema as it stood when AssetHub was forked from the
-- VisionFund register.
--
-- Migrations 001-003, 005 and 006 were never committed, so this file is what a
-- new database is built from. Run this first on an empty database, then 004,
-- 007, 008 and 009 in order.
--
-- Generated with pg_dump 18.4 --schema-only. Structure, not data.
--
-- PostgreSQL database dump
--

\restrict 9PIgSAo9xjjvFoMe2d3R7IBEawiq3CpSn2eJeagjf32hkY15YbDUjCqaroJfQJt

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: asset; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset (
    id integer NOT NULL,
    asset_code character varying(50) NOT NULL,
    description character varying(255) NOT NULL,
    asset_category_id integer,
    serial_number character varying(150),
    date_of_purchase date,
    purchase_price numeric(14,2),
    supplier character varying(150),
    useful_life_years numeric(6,2),
    remaining_life numeric(6,2),
    monthly_depreciation numeric(14,2),
    accumulated_depreciation numeric(14,2),
    nbv numeric(14,2),
    current_end_month_date date,
    condition character varying(150) DEFAULT 'Good'::character varying,
    status character varying(150) DEFAULT 'In Stock'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    chassis_number text,
    engine_number text,
    approval_status text DEFAULT 'approved'::text NOT NULL,
    created_by integer,
    approved_by integer,
    approved_at timestamp without time zone,
    rejection_reason text,
    import_batch_id integer,
    CONSTRAINT asset_approval_status_valid CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT asset_not_self_approved CHECK (((approved_by IS NULL) OR (created_by IS NULL) OR (approved_by <> created_by)))
);


--
-- Name: asset_category; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_category (
    id integer NOT NULL,
    name character varying(50) NOT NULL
);


--
-- Name: asset_category_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_category_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_category_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_category_id_seq OWNED BY public.asset_category.id;


--
-- Name: asset_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_id_seq OWNED BY public.asset.id;


--
-- Name: asset_verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.asset_verification (
    id integer NOT NULL,
    asset_id integer NOT NULL,
    verified_by integer NOT NULL,
    condition character varying(30) NOT NULL,
    remarks text,
    latitude double precision,
    longitude double precision,
    verified_at timestamp without time zone DEFAULT now() NOT NULL,
    edited_by integer,
    edited_at timestamp without time zone,
    status text DEFAULT 'approved'::text NOT NULL,
    approved_by integer,
    approved_at timestamp without time zone,
    rejection_reason text,
    CONSTRAINT asset_verification_condition_check CHECK (((condition)::text = ANY ((ARRAY['Good'::character varying, 'Good with issues'::character varying, 'Faulty'::character varying])::text[]))),
    CONSTRAINT verification_not_self_approved CHECK (((approved_by IS NULL) OR (approved_by <> verified_by))),
    CONSTRAINT verification_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: asset_verification_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.asset_verification_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: asset_verification_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.asset_verification_id_seq OWNED BY public.asset_verification.id;


--
-- Name: assignment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment (
    id integer NOT NULL,
    asset_id integer,
    employee_id integer,
    location_id integer,
    assigned_date timestamp without time zone DEFAULT now(),
    returned_date timestamp without time zone,
    assigned_by integer,
    approval_status text DEFAULT 'approved'::text NOT NULL,
    requested_by integer,
    approved_by integer,
    approved_at timestamp without time zone,
    rejection_reason text,
    return_approval_status text,
    return_requested_by integer,
    return_approved_by integer,
    condition_at_handover text,
    verification_id integer,
    CONSTRAINT assignment_approval_valid CHECK ((approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT assignment_not_self_approved CHECK (((approved_by IS NULL) OR (requested_by IS NULL) OR (approved_by <> requested_by))),
    CONSTRAINT assignment_return_approval_valid CHECK (((return_approval_status IS NULL) OR (return_approval_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))))
);


--
-- Name: assignment_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.assignment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: assignment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.assignment_id_seq OWNED BY public.assignment.id;


--
-- Name: bot_query_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_query_log (
    id integer NOT NULL,
    platform_user_id text,
    username character varying(100),
    query text,
    intent character varying(50),
    response text,
    created_at timestamp without time zone DEFAULT now(),
    staff_id integer,
    scoped_to_branch text,
    refused boolean DEFAULT false NOT NULL
);


--
-- Name: bot_query_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bot_query_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bot_query_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bot_query_log_id_seq OWNED BY public.bot_query_log.id;


--
-- Name: custody_request; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custody_request (
    id integer NOT NULL,
    asset_id integer NOT NULL,
    kind text NOT NULL,
    to_employee_id integer,
    to_location_id integer,
    from_employee_id integer,
    from_location_id integer,
    condition_at_handover text,
    notes text,
    latitude numeric(10,7),
    longitude numeric(10,7),
    status text DEFAULT 'pending'::text NOT NULL,
    requested_by integer NOT NULL,
    requested_at timestamp without time zone DEFAULT now() NOT NULL,
    reviewed_by integer,
    reviewed_at timestamp without time zone,
    rejection_reason text,
    assignment_id integer,
    verification_id integer,
    CONSTRAINT custody_destination_matches_kind CHECK ((((kind = 'assign'::text) AND ((to_employee_id IS NOT NULL) OR (to_location_id IS NOT NULL))) OR ((kind = 'return'::text) AND (to_employee_id IS NULL) AND (to_location_id IS NULL)))),
    CONSTRAINT custody_kind_valid CHECK ((kind = ANY (ARRAY['assign'::text, 'return'::text]))),
    CONSTRAINT custody_not_self_approved CHECK (((reviewed_by IS NULL) OR (reviewed_by <> requested_by))),
    CONSTRAINT custody_status_valid CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: custody_request_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.custody_request_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: custody_request_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.custody_request_id_seq OWNED BY public.custody_request.id;


--
-- Name: disposal_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disposal_record (
    id integer NOT NULL,
    asset_id integer,
    base_gross_value numeric(14,2),
    accumulated_depreciation numeric(14,2),
    nbv_at_disposal numeric(14,2),
    sales_proceeds numeric(14,2),
    gain_or_loss numeric(14,2),
    disposal_month date,
    disposed_by integer,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: disposal_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.disposal_record_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: disposal_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.disposal_record_id_seq OWNED BY public.disposal_record.id;


--
-- Name: employee; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee (
    id integer NOT NULL,
    name character varying(150) NOT NULL,
    department character varying(100),
    branch character varying(100),
    email character varying(150),
    employment_status text DEFAULT 'active'::text NOT NULL,
    last_working_day date,
    exit_reason text,
    CONSTRAINT employee_status_valid CHECK ((employment_status = ANY (ARRAY['active'::text, 'exiting'::text, 'exited'::text])))
);


--
-- Name: employee_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.employee_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: employee_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.employee_id_seq OWNED BY public.employee.id;


--
-- Name: exit_clearance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exit_clearance (
    id integer NOT NULL,
    employee_id integer NOT NULL,
    last_working_day date NOT NULL,
    deadline date NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    reason text,
    involves_fraud boolean DEFAULT false NOT NULL,
    opened_by integer,
    opened_at timestamp without time zone DEFAULT now() NOT NULL,
    completed_by integer,
    completed_at timestamp without time zone,
    notes text,
    CONSTRAINT clearance_deadline_after_exit CHECK ((deadline >= last_working_day)),
    CONSTRAINT clearance_status_valid CHECK ((status = ANY (ARRAY['open'::text, 'complete'::text, 'cancelled'::text])))
);


--
-- Name: exit_clearance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.exit_clearance_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exit_clearance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.exit_clearance_id_seq OWNED BY public.exit_clearance.id;


--
-- Name: exit_clearance_item; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.exit_clearance_item (
    id integer NOT NULL,
    clearance_id integer NOT NULL,
    asset_id integer NOT NULL,
    value_at_exit numeric(14,2),
    outcome text DEFAULT 'outstanding'::text NOT NULL,
    resolved_by integer,
    resolved_at timestamp without time zone,
    notes text,
    CONSTRAINT item_outcome_valid CHECK ((outcome = ANY (ARRAY['outstanding'::text, 'returned'::text, 'written_off'::text, 'owed'::text])))
);


--
-- Name: exit_clearance_item_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.exit_clearance_item_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: exit_clearance_item_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.exit_clearance_item_id_seq OWNED BY public.exit_clearance_item.id;


--
-- Name: import_batch; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_batch (
    id integer NOT NULL,
    filename text NOT NULL,
    sheet_names text[],
    mode text NOT NULL,
    rows_read integer DEFAULT 0 NOT NULL,
    rows_added integer DEFAULT 0 NOT NULL,
    rows_updated integer DEFAULT 0 NOT NULL,
    rows_unchanged integer DEFAULT 0 NOT NULL,
    rows_rejected integer DEFAULT 0 NOT NULL,
    rejections jsonb,
    created_codes text[],
    imported_by integer,
    imported_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_mode_valid CHECK ((mode = ANY (ARRAY['add'::text, 'upsert'::text, 'preview'::text])))
);


--
-- Name: import_batch_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.import_batch_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: import_batch_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.import_batch_id_seq OWNED BY public.import_batch.id;


--
-- Name: it_staff; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.it_staff (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    email character varying(150) NOT NULL,
    password_hash text NOT NULL,
    role character varying(40) DEFAULT 'IT Staff'::character varying,
    created_at timestamp without time zone DEFAULT now(),
    must_change_password boolean DEFAULT false NOT NULL,
    password_changed_at timestamp without time zone,
    branch text,
    slack_user_id text
);


--
-- Name: COLUMN it_staff.role; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.it_staff.role IS 'Admin | Administration Officer | Branch Administrator | Auditor | Finance';


--
-- Name: it_staff_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.it_staff_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: it_staff_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.it_staff_id_seq OWNED BY public.it_staff.id;


--
-- Name: knowledge_base; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.knowledge_base (
    id integer NOT NULL,
    category character varying(100) NOT NULL,
    question text NOT NULL,
    answer text NOT NULL,
    keywords text[],
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: knowledge_base_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.knowledge_base_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: knowledge_base_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.knowledge_base_id_seq OWNED BY public.knowledge_base.id;


--
-- Name: location; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.location (
    id integer NOT NULL,
    branch character varying(100) NOT NULL,
    department character varying(100),
    physical_location character varying(150),
    latitude numeric(9,6),
    longitude numeric(9,6),
    programme text,
    region text
);


--
-- Name: location_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.location_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: location_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.location_id_seq OWNED BY public.location.id;


--
-- Name: lost_asset_record; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lost_asset_record (
    id integer NOT NULL,
    asset_id integer,
    last_known_employee_id integer,
    last_known_location_id integer,
    reported_by integer,
    reported_date date DEFAULT CURRENT_DATE,
    notes text,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: lost_asset_record_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lost_asset_record_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lost_asset_record_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lost_asset_record_id_seq OWNED BY public.lost_asset_record.id;


--
-- Name: scan_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_log (
    id integer NOT NULL,
    asset_id integer,
    scanned_by integer,
    action character varying(30) NOT NULL,
    from_location_id integer,
    to_location_id integer,
    from_employee_id integer,
    to_employee_id integer,
    notes text,
    "timestamp" timestamp without time zone DEFAULT now(),
    latitude numeric(9,6),
    longitude numeric(9,6)
);


--
-- Name: scan_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scan_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scan_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scan_log_id_seq OWNED BY public.scan_log.id;


--
-- Name: asset id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset ALTER COLUMN id SET DEFAULT nextval('public.asset_id_seq'::regclass);


--
-- Name: asset_category id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_category ALTER COLUMN id SET DEFAULT nextval('public.asset_category_id_seq'::regclass);


--
-- Name: asset_verification id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_verification ALTER COLUMN id SET DEFAULT nextval('public.asset_verification_id_seq'::regclass);


--
-- Name: assignment id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment ALTER COLUMN id SET DEFAULT nextval('public.assignment_id_seq'::regclass);


--
-- Name: bot_query_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_query_log ALTER COLUMN id SET DEFAULT nextval('public.bot_query_log_id_seq'::regclass);


--
-- Name: custody_request id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request ALTER COLUMN id SET DEFAULT nextval('public.custody_request_id_seq'::regclass);


--
-- Name: disposal_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disposal_record ALTER COLUMN id SET DEFAULT nextval('public.disposal_record_id_seq'::regclass);


--
-- Name: employee id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee ALTER COLUMN id SET DEFAULT nextval('public.employee_id_seq'::regclass);


--
-- Name: exit_clearance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance ALTER COLUMN id SET DEFAULT nextval('public.exit_clearance_id_seq'::regclass);


--
-- Name: exit_clearance_item id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance_item ALTER COLUMN id SET DEFAULT nextval('public.exit_clearance_item_id_seq'::regclass);


--
-- Name: import_batch id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batch ALTER COLUMN id SET DEFAULT nextval('public.import_batch_id_seq'::regclass);


--
-- Name: it_staff id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.it_staff ALTER COLUMN id SET DEFAULT nextval('public.it_staff_id_seq'::regclass);


--
-- Name: knowledge_base id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_base ALTER COLUMN id SET DEFAULT nextval('public.knowledge_base_id_seq'::regclass);


--
-- Name: location id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.location ALTER COLUMN id SET DEFAULT nextval('public.location_id_seq'::regclass);


--
-- Name: lost_asset_record id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lost_asset_record ALTER COLUMN id SET DEFAULT nextval('public.lost_asset_record_id_seq'::regclass);


--
-- Name: scan_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log ALTER COLUMN id SET DEFAULT nextval('public.scan_log_id_seq'::regclass);


--
-- Name: asset asset_asset_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_asset_code_key UNIQUE (asset_code);


--
-- Name: asset_category asset_category_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_category
    ADD CONSTRAINT asset_category_name_key UNIQUE (name);


--
-- Name: asset_category asset_category_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_category
    ADD CONSTRAINT asset_category_pkey PRIMARY KEY (id);


--
-- Name: asset asset_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_pkey PRIMARY KEY (id);


--
-- Name: asset_verification asset_verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_verification
    ADD CONSTRAINT asset_verification_pkey PRIMARY KEY (id);


--
-- Name: assignment assignment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_pkey PRIMARY KEY (id);


--
-- Name: bot_query_log bot_query_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_query_log
    ADD CONSTRAINT bot_query_log_pkey PRIMARY KEY (id);


--
-- Name: custody_request custody_request_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_pkey PRIMARY KEY (id);


--
-- Name: disposal_record disposal_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disposal_record
    ADD CONSTRAINT disposal_record_pkey PRIMARY KEY (id);


--
-- Name: employee employee_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee
    ADD CONSTRAINT employee_email_key UNIQUE (email);


--
-- Name: employee employee_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee
    ADD CONSTRAINT employee_email_unique UNIQUE (email);


--
-- Name: employee employee_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee
    ADD CONSTRAINT employee_pkey PRIMARY KEY (id);


--
-- Name: exit_clearance_item exit_clearance_item_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance_item
    ADD CONSTRAINT exit_clearance_item_pkey PRIMARY KEY (id);


--
-- Name: exit_clearance exit_clearance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance
    ADD CONSTRAINT exit_clearance_pkey PRIMARY KEY (id);


--
-- Name: import_batch import_batch_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batch
    ADD CONSTRAINT import_batch_pkey PRIMARY KEY (id);


--
-- Name: it_staff it_staff_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.it_staff
    ADD CONSTRAINT it_staff_email_key UNIQUE (email);


--
-- Name: it_staff it_staff_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.it_staff
    ADD CONSTRAINT it_staff_pkey PRIMARY KEY (id);


--
-- Name: exit_clearance_item item_unique_per_clearance; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance_item
    ADD CONSTRAINT item_unique_per_clearance UNIQUE (clearance_id, asset_id);


--
-- Name: knowledge_base knowledge_base_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.knowledge_base
    ADD CONSTRAINT knowledge_base_pkey PRIMARY KEY (id);


--
-- Name: location location_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.location
    ADD CONSTRAINT location_pkey PRIMARY KEY (id);


--
-- Name: lost_asset_record lost_asset_record_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lost_asset_record
    ADD CONSTRAINT lost_asset_record_pkey PRIMARY KEY (id);


--
-- Name: scan_log scan_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_pkey PRIMARY KEY (id);


--
-- Name: idx_asset_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_code ON public.asset USING btree (asset_code);


--
-- Name: idx_asset_import_batch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_import_batch ON public.asset USING btree (import_batch_id) WHERE (import_batch_id IS NOT NULL);


--
-- Name: idx_asset_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_pending ON public.asset USING btree (approval_status) WHERE (approval_status = 'pending'::text);


--
-- Name: idx_asset_verification_asset_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_asset_verification_asset_id ON public.asset_verification USING btree (asset_id);


--
-- Name: idx_assignment_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignment_active ON public.assignment USING btree (asset_id) WHERE (returned_date IS NULL);


--
-- Name: idx_assignment_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignment_asset ON public.assignment USING btree (asset_id);


--
-- Name: idx_assignment_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_assignment_pending ON public.assignment USING btree (approval_status) WHERE (approval_status = 'pending'::text);


--
-- Name: idx_clearance_item_outstanding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clearance_item_outstanding ON public.exit_clearance_item USING btree (clearance_id) WHERE (outcome = 'outstanding'::text);


--
-- Name: idx_custody_request_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custody_request_asset ON public.custody_request USING btree (asset_id);


--
-- Name: idx_custody_request_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_custody_request_pending ON public.custody_request USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_employee_not_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_not_active ON public.employee USING btree (employment_status) WHERE (employment_status <> 'active'::text);


--
-- Name: idx_import_batch_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_import_batch_at ON public.import_batch USING btree (imported_at DESC);


--
-- Name: idx_it_staff_slack_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_it_staff_slack_user_id ON public.it_staff USING btree (slack_user_id) WHERE (slack_user_id IS NOT NULL);


--
-- Name: idx_one_open_clearance_per_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_one_open_clearance_per_employee ON public.exit_clearance USING btree (employee_id) WHERE (status = 'open'::text);


--
-- Name: idx_one_open_request_per_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_one_open_request_per_asset ON public.custody_request USING btree (asset_id) WHERE (status = 'pending'::text);


--
-- Name: idx_scan_log_asset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scan_log_asset ON public.scan_log USING btree (asset_id);


--
-- Name: idx_verification_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_verification_pending ON public.asset_verification USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: asset asset_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.it_staff(id);


--
-- Name: asset asset_asset_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_asset_category_id_fkey FOREIGN KEY (asset_category_id) REFERENCES public.asset_category(id);


--
-- Name: asset asset_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.it_staff(id);


--
-- Name: asset asset_import_batch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset
    ADD CONSTRAINT asset_import_batch_id_fkey FOREIGN KEY (import_batch_id) REFERENCES public.import_batch(id);


--
-- Name: asset_verification asset_verification_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_verification
    ADD CONSTRAINT asset_verification_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.it_staff(id);


--
-- Name: asset_verification asset_verification_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_verification
    ADD CONSTRAINT asset_verification_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: asset_verification asset_verification_edited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_verification
    ADD CONSTRAINT asset_verification_edited_by_fkey FOREIGN KEY (edited_by) REFERENCES public.it_staff(id);


--
-- Name: asset_verification asset_verification_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.asset_verification
    ADD CONSTRAINT asset_verification_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.it_staff(id);


--
-- Name: assignment assignment_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.it_staff(id);


--
-- Name: assignment assignment_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: assignment assignment_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.it_staff(id);


--
-- Name: assignment assignment_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(id);


--
-- Name: assignment assignment_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.location(id);


--
-- Name: assignment assignment_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.it_staff(id);


--
-- Name: assignment assignment_return_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_return_approved_by_fkey FOREIGN KEY (return_approved_by) REFERENCES public.it_staff(id);


--
-- Name: assignment assignment_return_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_return_requested_by_fkey FOREIGN KEY (return_requested_by) REFERENCES public.it_staff(id);


--
-- Name: assignment assignment_verification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment
    ADD CONSTRAINT assignment_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.asset_verification(id);


--
-- Name: bot_query_log bot_query_log_staff_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_query_log
    ADD CONSTRAINT bot_query_log_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.it_staff(id);


--
-- Name: custody_request custody_request_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: custody_request custody_request_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_assignment_id_fkey FOREIGN KEY (assignment_id) REFERENCES public.assignment(id);


--
-- Name: custody_request custody_request_from_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_from_employee_id_fkey FOREIGN KEY (from_employee_id) REFERENCES public.employee(id);


--
-- Name: custody_request custody_request_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES public.location(id);


--
-- Name: custody_request custody_request_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.it_staff(id);


--
-- Name: custody_request custody_request_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.it_staff(id);


--
-- Name: custody_request custody_request_to_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_to_employee_id_fkey FOREIGN KEY (to_employee_id) REFERENCES public.employee(id);


--
-- Name: custody_request custody_request_to_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES public.location(id);


--
-- Name: custody_request custody_request_verification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custody_request
    ADD CONSTRAINT custody_request_verification_id_fkey FOREIGN KEY (verification_id) REFERENCES public.asset_verification(id);


--
-- Name: disposal_record disposal_record_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disposal_record
    ADD CONSTRAINT disposal_record_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: disposal_record disposal_record_disposed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disposal_record
    ADD CONSTRAINT disposal_record_disposed_by_fkey FOREIGN KEY (disposed_by) REFERENCES public.it_staff(id);


--
-- Name: exit_clearance exit_clearance_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance
    ADD CONSTRAINT exit_clearance_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES public.it_staff(id);


--
-- Name: exit_clearance exit_clearance_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance
    ADD CONSTRAINT exit_clearance_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employee(id);


--
-- Name: exit_clearance_item exit_clearance_item_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance_item
    ADD CONSTRAINT exit_clearance_item_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: exit_clearance_item exit_clearance_item_clearance_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance_item
    ADD CONSTRAINT exit_clearance_item_clearance_id_fkey FOREIGN KEY (clearance_id) REFERENCES public.exit_clearance(id) ON DELETE CASCADE;


--
-- Name: exit_clearance_item exit_clearance_item_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance_item
    ADD CONSTRAINT exit_clearance_item_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.it_staff(id);


--
-- Name: exit_clearance exit_clearance_opened_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.exit_clearance
    ADD CONSTRAINT exit_clearance_opened_by_fkey FOREIGN KEY (opened_by) REFERENCES public.it_staff(id);


--
-- Name: import_batch import_batch_imported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_batch
    ADD CONSTRAINT import_batch_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES public.it_staff(id);


--
-- Name: lost_asset_record lost_asset_record_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lost_asset_record
    ADD CONSTRAINT lost_asset_record_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: lost_asset_record lost_asset_record_last_known_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lost_asset_record
    ADD CONSTRAINT lost_asset_record_last_known_employee_id_fkey FOREIGN KEY (last_known_employee_id) REFERENCES public.employee(id);


--
-- Name: lost_asset_record lost_asset_record_last_known_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lost_asset_record
    ADD CONSTRAINT lost_asset_record_last_known_location_id_fkey FOREIGN KEY (last_known_location_id) REFERENCES public.location(id);


--
-- Name: lost_asset_record lost_asset_record_reported_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lost_asset_record
    ADD CONSTRAINT lost_asset_record_reported_by_fkey FOREIGN KEY (reported_by) REFERENCES public.it_staff(id);


--
-- Name: scan_log scan_log_asset_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_asset_id_fkey FOREIGN KEY (asset_id) REFERENCES public.asset(id);


--
-- Name: scan_log scan_log_from_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_from_employee_id_fkey FOREIGN KEY (from_employee_id) REFERENCES public.employee(id);


--
-- Name: scan_log scan_log_from_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_from_location_id_fkey FOREIGN KEY (from_location_id) REFERENCES public.location(id);


--
-- Name: scan_log scan_log_scanned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_scanned_by_fkey FOREIGN KEY (scanned_by) REFERENCES public.it_staff(id);


--
-- Name: scan_log scan_log_to_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_to_employee_id_fkey FOREIGN KEY (to_employee_id) REFERENCES public.employee(id);


--
-- Name: scan_log scan_log_to_location_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_log
    ADD CONSTRAINT scan_log_to_location_id_fkey FOREIGN KEY (to_location_id) REFERENCES public.location(id);


--
-- Name: asset_verification; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.asset_verification ENABLE ROW LEVEL SECURITY;

--
-- Name: disposal_record; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.disposal_record ENABLE ROW LEVEL SECURITY;

--
-- Name: lost_asset_record; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lost_asset_record ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_log ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

\unrestrict 9PIgSAo9xjjvFoMe2d3R7IBEawiq3CpSn2eJeagjf32hkY15YbDUjCqaroJfQJt

