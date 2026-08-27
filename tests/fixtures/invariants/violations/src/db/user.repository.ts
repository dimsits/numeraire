// Fixture: unscoped repository access -- no userId in the signature.
export class UserRepository {
  findById(id: string): Promise<unknown> {
    return Promise.resolve(id);
  }
}
