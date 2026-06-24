// Core data model. Shared by every interface (CLI, web, future Pi/Arduino).
// Times are integer epoch milliseconds. Durations are integer milliseconds.
// We never store floats — drift-free and exact. ponytail: ints over floats, no rounding bugs.

/** A thing the user wants to dedicate time to: a hobby, a category, a task.
 *  e.g. "Writing", "Cooking", "Studying". NOT a specific session — the bucket. */
                       
                                                                                    
             
                                                        
               
                                                                        
                          
                                                              
                       
                                                                         
                                                                           
                        
                                              
                    

                                                                                  
                                                                              
                                                                                
                          
                                                                        
                                  
                                                                
                                                 
                          
                                                                             
                           
                                                                          
                                                                    
                              
 

/** Alarm behavior at countdown zero. Mirrors a physical alarm-duration switch:
 *  a real chime, a short blip, or silent (visual pulse only). */
                                                     

/** Direction of a card's day-count. */
                                             

/** A normalized view of a card's deadline for rendering. */
                           
                                                                             
               
                     
                                                                     
                  
 

/** One tracked stretch of time against a card. Closed when ended. */
                          
             
                 
                                                                                
                  
                                                                   
                          
                    
                                                        
                         
                                                                  
                   
                                                                         
                          
 

                                      

/** What the slotted card is doing right now. Drives the big button. */
                                                                             

/** The single "device slot": which card is in, and its live session.
 *  Exactly one card occupies the slot at a time (by design). */
                       
                        
                                                                            
                          
                                                                            
                                                                         
                   
 

/** A point-in-time snapshot for any interface to render. Pure derived data. */
                           
                  
                    
                                                                                            
                    
                                                                     
                             
                         
                                                                                     
                    
                                                                                     
                         
                                                      
                  
                                                                   
                            
 

/** Storage contract. SQLite (CLI/Pi) and IndexedDB (web) each implement this.
 *  Deliberately tiny: the core holds all logic, adapters only persist. */
                          
          
                                        
                                            
                               
                                        
                                        
                                                                            
                                                     

                       
                                              
                                                    

                                                
                           
                                     
 
