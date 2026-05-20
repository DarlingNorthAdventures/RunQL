import { ConnectionProfile, ConnectionType, DPConnectionFieldSchema, DPProviderDescriptor } from '../core/types';

export const STANDARD_CONNECTION_TYPE_FIELD: DPConnectionFieldSchema = {
    key: 'connectionType',
    label: 'Connection Type',
    type: 'radio',
    tab: 'connection',
    storage: 'profile',
    required: true,
    defaultValue: 'data_access',
    width: 'full',
    options: [
        {
            value: 'data_access',
            label: 'Data Access',
            description: 'A connection to your analytics or application database.',
        },
        {
            value: 'db_admin',
            label: 'DB Admin',
            description: 'A connection to your database server admin schemas. e.g. information_schema',
        },
    ],
};

export function normalizeConnectionType(value: unknown): ConnectionType {
    if (value === 'db_admin' || value === 'dbadmin') {
        return 'db_admin';
    }
    return 'data_access';
}

export function normalizeProfileConnectionType(profile: ConnectionProfile): ConnectionType {
    const normalized = normalizeConnectionType((profile as unknown as Record<string, unknown>).connectionType);
    profile.connectionType = normalized;
    return normalized;
}

export function isDbAdminConnection(profile: ConnectionProfile): boolean {
    return normalizeConnectionType(profile.connectionType) === 'db_admin';
}

export function formatConnectionTypeLabel(value: unknown): string {
    return normalizeConnectionType(value) === 'db_admin' ? 'DB Admin' : 'Data Access';
}

export function withStandardConnectionTypeSupport(descriptor: DPProviderDescriptor): DPProviderDescriptor {
    if (!descriptor.supports.dbAdminConnectionType) {
        return descriptor;
    }

    const fields = descriptor.formSchema.fields.map((field) => {
        if ((field.key === 'database' || field.key === 'schema') && !field.visibleWhen) {
            return {
                ...field,
                visibleWhen: { storage: 'profile' as const, key: 'connectionType', notEquals: 'db_admin' },
            };
        }
        return field;
    });

    if (!fields.some((field) => field.key === 'connectionType')) {
        const databaseIndex = fields.findIndex((field) => field.key === 'database' || field.key === 'schema');
        const portIndex = fields.findIndex((field) => field.key === 'port');
        const insertAt = databaseIndex >= 0 ? databaseIndex : portIndex >= 0 ? portIndex + 1 : fields.length;
        fields.splice(insertAt, 0, STANDARD_CONNECTION_TYPE_FIELD);
    }

    const reuse = descriptor.formSchema.reuse;
    const includeProfileKeys = Array.from(new Set([...(reuse?.includeProfileKeys ?? []), 'connectionType']));

    return {
        ...descriptor,
        formSchema: {
            ...descriptor.formSchema,
            fields,
            reuse: {
                ...reuse,
                includeProfileKeys,
            },
        },
    };
}
