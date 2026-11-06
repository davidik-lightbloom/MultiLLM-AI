export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          name: string | null;
          plan: 'free' | 'pro' | 'enterprise';
          credits: number;
          credits_period_start: string;
          plan_expires_at: string | null;
          is_active: boolean;
          local_only_mode: boolean;
          default_mode: 'fast' | 'deep';
          enabled_skills: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          name?: string | null;
          plan?: 'free' | 'pro' | 'enterprise';
          credits?: number;
          credits_period_start?: string;
          plan_expires_at?: string | null;
          is_active?: boolean;
          local_only_mode?: boolean;
          default_mode?: 'fast' | 'deep';
          enabled_skills?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          name?: string | null;
          plan?: 'free' | 'pro' | 'enterprise';
          credits?: number;
          credits_period_start?: string;
          plan_expires_at?: string | null;
          is_active?: boolean;
          local_only_mode?: boolean;
          default_mode?: 'fast' | 'deep';
          enabled_skills?: Json;
          created_at?: string;
          updated_at?: string;
        };
      };
      api_keys: {
        Row: {
          id: string;
          user_id: string;
          provider: 'openai' | 'gemini' | 'mistral' | 'openrouter';
          name: string;
          encrypted_key: string;
          is_active: boolean;
          usage_count: number;
          last_used_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          provider: 'openai' | 'gemini' | 'mistral' | 'openrouter';
          name: string;
          encrypted_key: string;
          is_active?: boolean;
          usage_count?: number;
          last_used_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          provider?: 'openai' | 'gemini' | 'mistral' | 'openrouter';
          name?: string;
          encrypted_key?: string;
          is_active?: boolean;
          usage_count?: number;
          last_used_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      queries: {
        Row: {
          id: string;
          user_id: string;
          project_id: string | null;
          prompt: string;
          answer: string;
          top_provider: string;
          top_model: string;
          confidence_score: number;
          latency_ms: number;
          carbon_saved: number;
          emissions: number;
          candidates: Json | null;
          sources: Json | null;
          estimated_cost_usd: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id?: string | null;
          prompt: string;
          answer: string;
          top_provider: string;
          top_model: string;
          confidence_score: number;
          latency_ms: number;
          carbon_saved: number;
          emissions: number;
          candidates?: Json | null;
          sources?: Json | null;
          estimated_cost_usd?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          project_id?: string | null;
          prompt?: string;
          answer?: string;
          top_provider?: string;
          top_model?: string;
          confidence_score?: number;
          latency_ms?: number;
          carbon_saved?: number;
          emissions?: number;
          candidates?: Json | null;
          sources?: Json | null;
          estimated_cost_usd?: number;
          created_at?: string;
        };
      };
      client_projects: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      training_jobs: {
        Row: {
          id: string;
          user_id: string;
          status: 'pending' | 'running' | 'completed' | 'failed';
          kind: 'generator' | 'scorer' | 'both';
          epochs: number;
          batch_size: number;
          n_layer: number;
          n_head: number;
          n_embd: number;
          learning_rate: number;
          logs: string | null;
          model_path: string | null;
          final_loss: number | null;
          started_at: string | null;
          completed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          status?: 'pending' | 'running' | 'completed' | 'failed';
          kind?: 'generator' | 'scorer' | 'both';
          epochs?: number;
          batch_size?: number;
          n_layer?: number;
          n_head?: number;
          n_embd?: number;
          learning_rate?: number;
          logs?: string | null;
          model_path?: string | null;
          final_loss?: number | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          status?: 'pending' | 'running' | 'completed' | 'failed';
          kind?: 'generator' | 'scorer' | 'both';
          epochs?: number;
          batch_size?: number;
          n_layer?: number;
          n_head?: number;
          n_embd?: number;
          learning_rate?: number;
          logs?: string | null;
          model_path?: string | null;
          final_loss?: number | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          stripe_customer_id: string;
          stripe_subscription_id: string | null;
          plan: 'free' | 'pro' | 'enterprise';
          status: 'active' | 'canceled' | 'past_due' | 'trialing';
          current_period_end: string | null;
          credits_included: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_customer_id: string;
          stripe_subscription_id?: string | null;
          plan?: 'free' | 'pro' | 'enterprise';
          status?: 'active' | 'canceled' | 'past_due' | 'trialing';
          current_period_end?: string | null;
          credits_included?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          stripe_customer_id?: string;
          stripe_subscription_id?: string | null;
          plan?: 'free' | 'pro' | 'enterprise';
          status?: 'active' | 'canceled' | 'past_due' | 'trialing';
          current_period_end?: string | null;
          credits_included?: number;
          created_at?: string;
          updated_at?: string;
        };
      };
      platform_api_keys: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          tier: 'free' | 'pro' | 'enterprise';
          key_prefix: string;
          key_hash: string;
          is_active: boolean;
          usage_count: number;
          last_used_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          tier?: 'free' | 'pro' | 'enterprise';
          key_prefix: string;
          key_hash: string;
          is_active?: boolean;
          usage_count?: number;
          last_used_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          tier?: 'free' | 'pro' | 'enterprise';
          key_prefix?: string;
          key_hash?: string;
          is_active?: boolean;
          usage_count?: number;
          last_used_at?: string | null;
          created_at?: string;
        };
      };
      query_errors: {
        Row: {
          id: string;
          user_id: string;
          reason: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          reason: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          reason?: string;
          created_at?: string;
        };
      };
      sent_emails: {
        Row: {
          id: string;
          user_id: string;
          email_type: 'welcome' | 'low_credits' | 'plan_expiring';
          period_key: string;
          sent_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          email_type: 'welcome' | 'low_credits' | 'plan_expiring';
          period_key: string;
          sent_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          email_type?: 'welcome' | 'low_credits' | 'plan_expiring';
          period_key?: string;
          sent_at?: string;
        };
      };
    };
    Views: {};
    Functions: {
      handle_new_user: { Args: Record<PropertyKey, never>; Returns: unknown };
      update_updated_at_column: { Args: Record<PropertyKey, never>; Returns: unknown };
      increment_api_key_usage: { Args: { key_id: string }; Returns: void };
      increment_platform_api_key_usage: { Args: { key_id: string }; Returns: void };
    };
    Enums: {
      plan_type: 'free' | 'pro' | 'enterprise';
      provider_type: 'openai' | 'gemini' | 'mistral' | 'openrouter';
      job_status: 'pending' | 'running' | 'completed' | 'failed';
      job_kind: 'generator' | 'scorer' | 'both';
      subscription_status: 'active' | 'canceled' | 'past_due' | 'trialing';
    };
    CompositeTypes: {};
  };
}